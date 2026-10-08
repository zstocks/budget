import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveMonth, reconcile, cardBalances, actualsByAccount } from '../src/ledger/derive.js';
import { STATUS, METHOD_TYPE, payoffTransitions } from '../src/ledger/status.js';

// One consistent November 2026 dataset (cents). The reconciliation identity
// (bank-side disposable === disposable now) must hold on it at every step.
//
// Income funding 2026-11:        projected    actual
//   Carryover                        50000     50000
//   Check Oct 25 (adopted)          320195    320195
//   Check Nov 6                     150000    150000
//   Check Nov 10                    320195      null   (not yet received)
//   Check Nov 21                    150000      null
//   Other                                0      null
// On deck: Check Nov 25, tagged 2026-12, received 320195.
//
// Accounts:  Rent 189300 | Groceries 15000 | Medical 25000 | Merchandise 15000
// Transactions: rent cleared on MACU; groceries on Zach's Discover (on_card);
// a split purchase on Citi (on_card); a pending MACU check.

const MONTH = '2026-11';
const MONTH_ID = 1;
const PRIOR_MONTH_ID = 0;

const MACU = 1;
const JACKIES_DISCOVER = 2;
const ZACHS_DISCOVER = 3;
const CITI = 4;

const RENT = 10;
const GROCERIES = 11;
const MEDICAL = 12;
const MERCHANDISE = 13;

const INCOME_PROJECTED = 990390;
const INCOME_ACTUAL = 520195;
const ON_DECK = 320195;
const EXPENSES_PROJECTED = 244300;
const EXPENSES_ACTUAL = 206367;
const CARD_BALANCE_TOTAL = 14567;   // Zach's Discover 4567 + Citi 10000
const PENDING_MACU_TOTAL = 2500;
const DISPOSABLE_NOW = INCOME_ACTUAL - EXPENSES_ACTUAL + ON_DECK;              // 634023
const BALANCED_BANK = DISPOSABLE_NOW + PENDING_MACU_TOTAL + CARD_BALANCE_TOTAL; // 651090

function baseSnapshot() {
    return {
        month: MONTH,
        availableInBank: BALANCED_BANK,
        paymentMethods: [
            { id: MACU, type: METHOD_TYPE.CHECKING },
            { id: JACKIES_DISCOVER, type: METHOD_TYPE.CREDIT },
            { id: ZACHS_DISCOVER, type: METHOD_TYPE.CREDIT },
            { id: CITI, type: METHOD_TYPE.CREDIT },
        ],
        incomeEntries: [
            { budget_month: MONTH, label: 'Carryover', projected: 50000, actual: 50000 },
            { budget_month: MONTH, label: 'Check Oct 25', projected: 320195, actual: 320195 },
            { budget_month: MONTH, label: 'Check Nov 6', projected: 150000, actual: 150000 },
            { budget_month: MONTH, label: 'Check Nov 10', projected: 320195, actual: null },
            { budget_month: MONTH, label: 'Check Nov 21', projected: 150000, actual: null },
            { budget_month: MONTH, label: 'Other', projected: 0, actual: null },
            { budget_month: '2026-12', label: 'Check Nov 25', projected: 320195, actual: 320195 },
        ],
        budgetAccounts: [
            { id: RENT, month_id: MONTH_ID, projected: 189300 },
            { id: GROCERIES, month_id: MONTH_ID, projected: 15000 },
            { id: MEDICAL, month_id: MONTH_ID, projected: 25000 },
            { id: MERCHANDISE, month_id: MONTH_ID, projected: 15000 },
        ],
        transactions: [
            { id: 1, month_id: MONTH_ID, payment_method_id: MACU, total: 189300, status: STATUS.CLEARED },
            { id: 2, month_id: MONTH_ID, payment_method_id: ZACHS_DISCOVER, total: 4567, status: STATUS.ON_CARD },
            { id: 3, month_id: MONTH_ID, payment_method_id: CITI, total: 10000, status: STATUS.ON_CARD },
            { id: 4, month_id: MONTH_ID, payment_method_id: MACU, total: 2500, status: STATUS.PENDING_MACU },
        ],
        splits: [
            { transaction_id: 1, budget_account_id: RENT, amount: 189300 },
            { transaction_id: 2, budget_account_id: GROCERIES, amount: 4567 },
            { transaction_id: 3, budget_account_id: GROCERIES, amount: 6000 },
            { transaction_id: 3, budget_account_id: MEDICAL, amount: 4000 },
            { transaction_id: 4, budget_account_id: MEDICAL, amount: 2500 },
        ],
    };
}

test('deriveMonth computes the full grid on the base dataset', () => {
    const grid = deriveMonth(baseSnapshot());

    assert.equal(grid.incomeProjected, INCOME_PROJECTED);
    assert.equal(grid.incomeActual, INCOME_ACTUAL);
    assert.equal(grid.onDeck, ON_DECK);
    assert.equal(grid.expensesProjected, EXPENSES_PROJECTED);
    assert.equal(grid.expensesActual, EXPENSES_ACTUAL);
    assert.equal(grid.unallocatedIncome, INCOME_PROJECTED - EXPENSES_PROJECTED);
    assert.equal(grid.disposableNow, DISPOSABLE_NOW);
    assert.equal(grid.pendingMacu, PENDING_MACU_TOTAL);
    assert.equal(grid.cardBalanceTotal, CARD_BALANCE_TOTAL);
});

test('on-deck check is excluded from income totals but included in disposable now', () => {
    const grid = deriveMonth(baseSnapshot());

    // Neither income number contains the 2026-12-tagged check...
    assert.equal(grid.incomeProjected, INCOME_PROJECTED);
    assert.equal(grid.incomeActual, INCOME_ACTUAL);
    // ...but the cash exists, so it is in on-deck and disposable now.
    assert.equal(grid.onDeck, 320195);
    assert.equal(grid.disposableNow, grid.incomeActual - grid.expensesActual + grid.onDeck);
});

test('unreceived entries count toward projected but never actual or on-deck', () => {
    const snapshot = baseSnapshot();
    // An unreceived future-tagged check must not appear anywhere actual.
    snapshot.incomeEntries.push(
        { budget_month: '2026-12', label: 'Check Dec 25', projected: 320195, actual: null }
    );
    const grid = deriveMonth(snapshot);
    assert.equal(grid.incomeProjected, INCOME_PROJECTED);  // not Nov-tagged
    assert.equal(grid.incomeActual, INCOME_ACTUAL);
    assert.equal(grid.onDeck, ON_DECK);                    // unreceived -> not on deck
});

test('per-account actuals and remaining, including an untouched account', () => {
    const grid = deriveMonth(baseSnapshot());

    assert.equal(grid.actualsByAccount.get(RENT), 189300);
    assert.equal(grid.actualsByAccount.get(GROCERIES), 10567);
    assert.equal(grid.actualsByAccount.get(MEDICAL), 6500);
    assert.equal(grid.actualsByAccount.get(MERCHANDISE), undefined);  // no splits yet

    assert.equal(grid.remainingByAccount.get(RENT), 0);
    assert.equal(grid.remainingByAccount.get(GROCERIES), 4433);
    assert.equal(grid.remainingByAccount.get(MEDICAL), 18500);
    assert.equal(grid.remainingByAccount.get(MERCHANDISE), 15000);    // full base remains
});

test('card balances are per-card, and zero-balance cards still appear', () => {
    const snapshot = baseSnapshot();
    const balances = cardBalances(snapshot.transactions, snapshot.paymentMethods);

    assert.deepEqual([...balances.entries()].sort(), [
        [JACKIES_DISCOVER, 0],
        [ZACHS_DISCOVER, 4567],
        [CITI, 10000],
    ].sort());
    assert.equal(balances.has(MACU), false);  // checking never has a card balance
});

test('reconciliation balances on the consistent dataset', () => {
    const grid = deriveMonth(baseSnapshot());
    assert.equal(grid.reconciliation.balanced, true);
    assert.equal(grid.reconciliation.discrepancy, 0);
    assert.equal(grid.reconciliation.bankSideDisposable, grid.disposableNow);
});

test('reconciliation stays balanced through a full card payoff lifecycle', () => {
    const snapshot = baseSnapshot();

    // Step 1: pay off Citi — pure status transition, bank number unchanged
    // (the payment is pending at MACU, so the cash hasn't left yet).
    const citiRows = snapshot.transactions.filter((t) => t.payment_method_id === CITI);
    for (const { id, to } of payoffTransitions(citiRows)) {
        snapshot.transactions.find((t) => t.id === id).status = to;
    }
    let grid = deriveMonth(snapshot);
    assert.equal(grid.expensesActual, EXPENSES_ACTUAL, 'payoff must not change expenses');
    assert.equal(grid.disposableNow, DISPOSABLE_NOW, 'payoff must not change disposable now');
    assert.equal(grid.cardBalanceTotal, 4567);
    assert.equal(grid.pendingMacu, PENDING_MACU_TOTAL + 10000);
    assert.equal(grid.reconciliation.balanced, true);

    // Step 2: the payoff clears — cash actually leaves checking.
    snapshot.transactions.find((t) => t.id === 3).status = STATUS.CLEARED;
    snapshot.availableInBank -= 10000;
    grid = deriveMonth(snapshot);
    assert.equal(grid.disposableNow, DISPOSABLE_NOW);
    assert.equal(grid.pendingMacu, PENDING_MACU_TOTAL);
    assert.equal(grid.reconciliation.balanced, true);
});

test('a prior-month transaction still on_card keeps reconciliation exact', () => {
    const snapshot = baseSnapshot();
    // An October purchase still sitting on Citi: it was expensed in October,
    // which lowered October's net and therefore November's Carryover by the
    // same amount — but the cash never left checking.
    snapshot.transactions.push(
        { id: 5, month_id: PRIOR_MONTH_ID, payment_method_id: CITI, total: 3000, status: STATUS.ON_CARD }
    );
    const carryover = snapshot.incomeEntries.find((e) => e.label === 'Carryover');
    carryover.projected -= 3000;
    carryover.actual -= 3000;

    const grid = deriveMonth(snapshot);
    assert.equal(grid.disposableNow, DISPOSABLE_NOW - 3000);
    assert.equal(grid.cardBalanceTotal, CARD_BALANCE_TOTAL + 3000);
    assert.equal(grid.reconciliation.balanced, true,
        'card balances must span all months or cross-month leftovers break reconciliation');
});

test('reconciliation reports a discrepancy when the bank number is off', () => {
    const snapshot = baseSnapshot();
    snapshot.availableInBank -= 1250;  // e.g. a forgotten bank fee
    const grid = deriveMonth(snapshot);
    assert.equal(grid.reconciliation.balanced, false);
    assert.equal(grid.reconciliation.discrepancy, -1250);
});

test('reconciliation is null, never a fake zero, while availableInBank is unset', () => {
    const snapshot = baseSnapshot();
    snapshot.availableInBank = null;
    const grid = deriveMonth(snapshot);
    assert.equal(grid.reconciliation.bankSideDisposable, null);
    assert.equal(grid.reconciliation.discrepancy, null);
    assert.equal(grid.reconciliation.balanced, null);
    assert.equal(grid.reconciliation.disposableNow, DISPOSABLE_NOW);

    assert.deepEqual(
        reconcile({ availableInBank: undefined, pendingMacuTotal: 0, cardBalanceTotal: 0, disposableNowAmount: 5 }),
        { bankSideDisposable: null, disposableNow: 5, discrepancy: null, balanced: null }
    );
});

test('a refund transaction reduces its account actual', () => {
    const snapshot = baseSnapshot();
    snapshot.transactions.push(
        { id: 6, month_id: MONTH_ID, payment_method_id: ZACHS_DISCOVER, total: -4567, status: STATUS.ON_CARD }
    );
    snapshot.splits.push(
        { transaction_id: 6, budget_account_id: GROCERIES, amount: -4567 }
    );
    const grid = deriveMonth(snapshot);
    assert.equal(grid.actualsByAccount.get(GROCERIES), 6000);
    assert.equal(grid.cardBalances.get(ZACHS_DISCOVER), 0);
    assert.equal(grid.reconciliation.balanced, true,
        'a refund raises disposable now and lowers the card balance by the same amount');
});

test('actualsByAccount sums raw splits', () => {
    assert.deepEqual(
        actualsByAccount([
            { budget_account_id: 1, amount: 100 },
            { budget_account_id: 1, amount: 250 },
            { budget_account_id: 2, amount: -50 },
        ]),
        new Map([[1, 350], [2, -50]])
    );
});
