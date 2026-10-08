// Derived values — pure functions over plain rows, no database access.
//
// The spreadsheet stored aggregates; the app stores transactions. Every
// number here is recomputed from income entries, budget accounts, and
// transaction splits — never stored.
//
// Scoping rules:
//   * Income and expenses are month-scoped (income by budget_month string,
//     expenses by the accounts passed in). Filtering income by budget_month
//     structurally excludes the day-25 check tagged for the following month.
//   * Card balances and the pending_macu sum are NOT month-scoped: they
//     describe the physical state of the cards and the bank account. A
//     late prior-month purchase still on_card was expensed in its own
//     month and flows forward via Carryover, but the cash hasn't left
//     checking — so it must still count on the bank side, or the
//     reconciliation identity breaks.

import { STATUS, METHOD_TYPE } from './status.js';

// --- Income ----------------------------------------------------------------

/** Sum of projected over entries funding this month. */
export function incomeProjected(incomeEntries, month) {
    return sum(
        incomeEntries.filter((e) => e.budget_month === month),
        (e) => e.projected
    );
}

/** Sum of actual over RECEIVED entries funding this month. */
export function incomeActual(incomeEntries, month) {
    return sum(
        incomeEntries.filter((e) => e.budget_month === month && e.actual !== null),
        (e) => e.actual
    );
}

/**
 * Check on Deck: money physically received but tagged to fund a FUTURE
 * month. Excluded from this month's income totals, but the cash exists in
 * checking, so it counts in Disposable Now and in bank-side reconciliation.
 * 'YYYY-MM' strings compare correctly as plain strings.
 */
export function onDeck(incomeEntries, month) {
    return sum(
        incomeEntries.filter((e) => e.budget_month > month && e.actual !== null),
        (e) => e.actual
    );
}

// --- Expenses ---------------------------------------------------------------

/** Map of budget_account_id -> sum of its split amounts. */
export function actualsByAccount(splits) {
    const totals = new Map();
    for (const s of splits) {
        totals.set(
            s.budget_account_id,
            (totals.get(s.budget_account_id) ?? 0) + s.amount
        );
    }
    return totals;
}

export function expensesProjected(budgetAccounts) {
    return sum(budgetAccounts, (a) => a.projected);
}

export function expensesActual(budgetAccounts, actuals) {
    return sum(budgetAccounts, (a) => actuals.get(a.id) ?? 0);
}

/** Map of budget_account_id -> projected − actual (no splits yet = actual 0). */
export function remainingByAccount(budgetAccounts, actuals) {
    const remaining = new Map();
    for (const a of budgetAccounts) {
        remaining.set(a.id, a.projected - (actuals.get(a.id) ?? 0));
    }
    return remaining;
}

// --- Physical money state (all months) ---------------------------------------

/**
 * Map of credit-method id -> sum of its on_card transaction totals.
 * Every credit method appears, zero-balance cards included.
 */
export function cardBalances(transactions, paymentMethods) {
    const balances = new Map();
    for (const m of paymentMethods) {
        if (m.type === METHOD_TYPE.CREDIT) {
            balances.set(m.id, 0);
        }
    }
    for (const t of transactions) {
        if (t.status === STATUS.ON_CARD && balances.has(t.payment_method_id)) {
            balances.set(
                t.payment_method_id,
                balances.get(t.payment_method_id) + t.total
            );
        }
    }
    return balances;
}

/** Sum over ALL pending_macu transactions, any method. */
export function pendingMacu(transactions) {
    return sum(
        transactions.filter((t) => t.status === STATUS.PENDING_MACU),
        (t) => t.total
    );
}

// --- Headline numbers ---------------------------------------------------------

export function unallocatedIncome(incomeProj, expensesProj) {
    return incomeProj - expensesProj;
}

export function disposableNow(incomeAct, expensesAct, onDeckAmount) {
    return incomeAct - expensesAct + onDeckAmount;
}

/**
 * Bank-side vs budget-side disposable. availableInBank is the ONE manually
 * entered number; while it is null (not yet entered), the bank-side fields
 * are null and balanced is null — "not yet reconcilable", never a fake zero.
 */
export function reconcile({ availableInBank, pendingMacuTotal, cardBalanceTotal, disposableNowAmount }) {
    if (availableInBank === null || availableInBank === undefined) {
        return {
            bankSideDisposable: null,
            disposableNow: disposableNowAmount,
            discrepancy: null,
            balanced: null,
        };
    }
    const bankSideDisposable = availableInBank - pendingMacuTotal - cardBalanceTotal;
    return {
        bankSideDisposable,
        disposableNow: disposableNowAmount,
        discrepancy: bankSideDisposable - disposableNowAmount,
        balanced: bankSideDisposable === disposableNowAmount,
    };
}

// --- Whole-grid convenience -----------------------------------------------------

/**
 * Compose everything into the full derived grid for one month.
 *
 * @param {{
 *     month: string,
 *     availableInBank: number | null,
 *     incomeEntries: Array,
 *     budgetAccounts: Array,   // this month's accounts
 *     transactions: Array,     // ALL transactions (card/pending state is global)
 *     splits: Array,           // splits of this month's transactions
 *     paymentMethods: Array,
 * }} snapshot
 */
export function deriveMonth(snapshot) {
    const {
        month, availableInBank, incomeEntries,
        budgetAccounts, transactions, splits, paymentMethods,
    } = snapshot;

    const actuals = actualsByAccount(splits);
    const incomeProj = incomeProjected(incomeEntries, month);
    const incomeAct = incomeActual(incomeEntries, month);
    const onDeckAmount = onDeck(incomeEntries, month);
    const expensesProj = expensesProjected(budgetAccounts);
    const expensesAct = expensesActual(budgetAccounts, actuals);
    const balances = cardBalances(transactions, paymentMethods);
    const pendingMacuTotal = pendingMacu(transactions);
    const cardBalanceTotal = sum([...balances.values()], (v) => v);
    const disposableNowAmount = disposableNow(incomeAct, expensesAct, onDeckAmount);

    return {
        incomeProjected: incomeProj,
        incomeActual: incomeAct,
        onDeck: onDeckAmount,
        expensesProjected: expensesProj,
        expensesActual: expensesAct,
        actualsByAccount: actuals,
        remainingByAccount: remainingByAccount(budgetAccounts, actuals),
        cardBalances: balances,
        cardBalanceTotal,
        pendingMacu: pendingMacuTotal,
        unallocatedIncome: unallocatedIncome(incomeProj, expensesProj),
        disposableNow: disposableNowAmount,
        reconciliation: reconcile({
            availableInBank, pendingMacuTotal, cardBalanceTotal, disposableNowAmount,
        }),
    };
}

function sum(rows, pick) {
    let total = 0;
    for (const row of rows) {
        total += pick(row);
    }
    return total;
}
