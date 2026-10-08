import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db/index.js';
import {
    createMonth, closeMonth, monthSnapshot,
    nextMonth, prevMonth, daysInMonth, instanceName,
    MONTH_STATUS, INCOME_KIND,
} from '../src/ledger/lifecycle.js';
import {
    addTransaction, payoffCard, transitionStatus,
    addIncomeEntry, receiveIncome,
    setAvailableInBank, setAccountProjected,
} from '../src/ledger/store.js';
import { deriveMonth } from '../src/ledger/derive.js';
import { STATUS } from '../src/ledger/status.js';
import { ERROR_CODES } from '../src/ledger/errors.js';

// --- Month-string helpers ---------------------------------------------------

test('month-string helpers handle year boundaries and leap years', () => {
    assert.equal(nextMonth('2026-12'), '2027-01');
    assert.equal(nextMonth('2026-08'), '2026-09');
    assert.equal(prevMonth('2027-01'), '2026-12');
    assert.equal(daysInMonth('2026-09'), 30);
    assert.equal(daysInMonth('2028-02'), 29);
    assert.equal(daysInMonth('2027-02'), 28);
});

test('food-week templates get per-month date-range labels; others pass through', () => {
    assert.equal(instanceName('Food W1 (Zach)', '2026-08'), 'Food W1 | 1–7 (Zach)');
    assert.equal(instanceName('Food W4 (Jackie)', '2026-08'), 'Food W4 | 22–31 (Jackie)');
    assert.equal(instanceName('Food W4 (Jackie)', '2026-09'), 'Food W4 | 22–30 (Jackie)');
    assert.equal(instanceName('Medical', '2026-08'), 'Medical');
});

// --- Full two-month lifecycle (acceptance gate) --------------------------------

function seededDb() {
    const db = openDb(':memory:');

    db.prepare('INSERT INTO users (name) VALUES (?)').run('Zach');
    const zach = 1;

    const method = db.prepare('INSERT INTO payment_methods (name, type) VALUES (?, ?)');
    const macu = Number(method.run('MACU', 'checking').lastInsertRowid);
    const zachsCard = Number(method.run("Zach's Discover", 'credit').lastInsertRowid);

    const tpl = db.prepare(`
        INSERT INTO account_templates (name, category, base_amount, rollover, sort_order)
        VALUES (?, ?, ?, ?, ?)
    `);
    const medicalTpl = Number(tpl.run('Medical', 'Expenses', 25000, 1, 0).lastInsertRowid);
    const groceriesTpl = Number(tpl.run('Groceries', 'Expenses', 15000, 0, 1).lastInsertRowid);
    tpl.run('Food W1 (Zach)', 'Expenses', 22500, 0, 2);
    tpl.run('Food W4 (Zach)', 'Expenses', 25000, 0, 3);

    const inc = db.prepare(`
        INSERT INTO income_templates (label, day_of_month, funds_next_month, amount, sort_order)
        VALUES (?, ?, ?, ?, ?)
    `);
    inc.run('Check (25th)', 25, 1, 320195, 0);
    inc.run('Check (10th)', 10, 0, 150000, 1);

    return { db, zach, macu, zachsCard, medicalTpl, groceriesTpl };
}

function accountByName(db, monthId, name) {
    return db.prepare('SELECT * FROM budget_accounts WHERE month_id = ? AND name = ?')
        .get(monthId, name);
}

function incomeRows(db, month) {
    return db.prepare('SELECT * FROM income_entries WHERE budget_month = ? ORDER BY sort_order, id')
        .all(month);
}

test('two-month lifecycle: create A, log, create B early, live derivation, close A, freeze', () => {
    const { db, zach, macu, zachsCard } = seededDb();
    const A = '2026-08';
    const B = '2026-09';

    // --- Create month A -------------------------------------------------------
    const aId = createMonth(db, A, '2026-07-28T12:00:00Z');

    const aAccounts = db.prepare('SELECT * FROM budget_accounts WHERE month_id = ?').all(aId);
    assert.deepEqual(
        aAccounts.map((a) => [a.name, a.projected]),
        [
            ['Medical', 25000], ['Groceries', 15000],
            ['Food W1 | 1–7 (Zach)', 22500], ['Food W4 | 22–31 (Zach)', 25000],
        ]
    );
    assert.deepEqual(
        incomeRows(db, A).map((e) => [e.kind, e.label, e.projected, e.actual]),
        [
            ['check', 'Check (25th)', 320195, null],
            ['check', 'Check (10th)', 150000, null],
            ['carryover', 'Carryover', 0, null],   // no previous month: bootstrap by hand
            ['other', 'Other', 0, null],
        ]
    );
    assert.throws(() => createMonth(db, A), { code: ERROR_CODES.MONTH_EXISTS });

    // --- Log month A activity ---------------------------------------------------
    const [aCheck25, aCheck10] = incomeRows(db, A);
    receiveIncome(db, aCheck25.id, 320195, '2026-07-25');
    receiveIncome(db, aCheck10.id, 150000, '2026-08-10');

    const medicalA = accountByName(db, aId, 'Medical');
    const groceriesA = accountByName(db, aId, 'Groceries');
    const cardTxId = addTransaction(db,
        { monthId: aId, date: '2026-08-03', description: 'Groceries run',
          paymentMethodId: zachsCard, total: 4567, loggedBy: zach },
        [{ budget_account_id: groceriesA.id, amount: 4567 }]);
    addTransaction(db,
        { monthId: aId, date: '2026-08-05', description: 'Pharmacy',
          paymentMethodId: macu, total: 10000, loggedBy: zach },
        [{ budget_account_id: medicalA.id, amount: 10000 }]);

    // Splits that don't sum are rejected at the store layer too.
    assert.throws(
        () => addTransaction(db,
            { monthId: aId, date: '2026-08-06', description: 'Bad split',
              paymentMethodId: macu, total: 1000, loggedBy: zach },
            [{ budget_account_id: medicalA.id, amount: 999 }]),
        { code: ERROR_CODES.SPLIT_SUM_MISMATCH }
    );

    // Day-25 check received Aug 25, tagged to fund September (on deck).
    addIncomeEntry(db, {
        budgetMonth: B, kind: INCOME_KIND.CHECK, label: 'Check (25th)',
        projected: 320195, actual: 320195, receivedDate: '2026-08-25',
    });

    let gridA = deriveMonth(monthSnapshot(db, A));
    assert.equal(gridA.incomeActual, 470195);   // September-tagged check excluded
    assert.equal(gridA.onDeck, 320195);
    assert.equal(gridA.expensesActual, 14567);

    // --- Create month B early (A still open — the NORMAL case) --------------------
    const bId = createMonth(db, B, '2026-08-27T12:00:00Z');

    const bChecks = incomeRows(db, B).filter((e) => e.kind === INCOME_KIND.CHECK);
    assert.equal(bChecks.length, 2, 'adopted day-25 check plus created day-10, no duplicate');
    assert.equal(bChecks[0].actual, 320195, 'the adopted row is the already-received check');

    // Stored placeholders while A is open: base / zero...
    assert.equal(accountByName(db, bId, 'Medical').projected, 25000);
    assert.equal(accountByName(db, bId, 'Food W4 | 22–30 (Zach)').projected, 25000);
    // ...but the snapshot live-derives from A: carryover 470195-14567,
    // Medical 25000 + (25000-10000).
    let gridB = deriveMonth(monthSnapshot(db, B));
    assert.equal(gridB.incomeActual, 455628 + 320195);
    const liveMedicalB = monthSnapshot(db, B).budgetAccounts.find((a) => a.name === 'Medical');
    assert.equal(liveMedicalB.projected, 40000);

    // Non-rollover and edited values are independent immediately.
    setAccountProjected(db, accountByName(db, bId, 'Groceries').id, 20000);

    // --- A late August transaction updates September's live numbers ----------------
    addTransaction(db,
        { monthId: aId, date: '2026-08-30', description: 'Late pharmacy',
          paymentMethodId: macu, total: 5000, loggedBy: zach },
        [{ budget_account_id: medicalA.id, amount: 5000 }]);

    const liveB = monthSnapshot(db, B);
    assert.equal(
        liveB.incomeEntries.find((e) => e.budget_month === B && e.kind === INCOME_KIND.CARRYOVER).projected,
        450628, 'carryover tracks late month-A changes while A is open'
    );
    assert.equal(
        liveB.budgetAccounts.find((a) => a.name === 'Medical').projected,
        35000, 'rollover tracks late month-A changes while A is open'
    );

    // --- Close A --------------------------------------------------------------------
    assert.throws(() => closeMonth(db, B), { code: ERROR_CODES.MONTH_PREV_OPEN });

    closeMonth(db, A, '2026-09-05T12:00:00Z');
    assert.equal(db.prepare('SELECT status FROM months WHERE id = ?').get(aId).status,
        MONTH_STATUS.CLOSED);

    // Live values are written down as B's own stored, editable values.
    const storedCarryover = incomeRows(db, B).find((e) => e.kind === INCOME_KIND.CARRYOVER);
    assert.equal(storedCarryover.projected, 450628);
    assert.equal(storedCarryover.actual, 450628);
    assert.equal(storedCarryover.received_date, '2026-09-05T12:00:00Z');
    assert.equal(accountByName(db, bId, 'Medical').projected, 35000);
    assert.equal(accountByName(db, bId, 'Groceries').projected, 20000,
        'close must not clobber non-rollover edits to the next month');
    gridB = deriveMonth(monthSnapshot(db, B));
    assert.equal(gridB.incomeActual, 450628 + 320195, 'stored values now match the last live view');

    // --- Closed month is read-only ----------------------------------------------------
    assert.throws(() => closeMonth(db, A), { code: ERROR_CODES.MONTH_CLOSED });
    assert.throws(
        () => addTransaction(db,
            { monthId: aId, date: '2026-09-06', description: 'Too late',
              paymentMethodId: macu, total: 100, loggedBy: zach },
            [{ budget_account_id: medicalA.id, amount: 100 }]),
        { code: ERROR_CODES.MONTH_CLOSED }
    );
    assert.throws(() => setAccountProjected(db, medicalA.id, 99999),
        { code: ERROR_CODES.MONTH_CLOSED });
    assert.throws(() => setAvailableInBank(db, aId, 100000),
        { code: ERROR_CODES.MONTH_CLOSED });
    assert.throws(() => receiveIncome(db, aCheck25.id, 1, '2026-09-06'),
        { code: ERROR_CODES.MONTH_CLOSED });
    assert.throws(
        () => addIncomeEntry(db, { budgetMonth: A, kind: 'other', label: 'Too late' }),
        { code: ERROR_CODES.MONTH_CLOSED }
    );

    // --- But status transitions stay legal: physical card state, not budget --------------
    const payoffIds = payoffCard(db, zachsCard);
    assert.deepEqual(payoffIds, [cardTxId], 'August purchase can be paid off after close');
    transitionStatus(db, cardTxId, STATUS.CLEARED);
    assert.equal(
        db.prepare('SELECT status FROM transactions WHERE id = ?').get(cardTxId).status,
        STATUS.CLEARED
    );
    const gridBAfterPayoff = deriveMonth(monthSnapshot(db, B));
    assert.equal(gridBAfterPayoff.expensesActual, gridB.expensesActual,
        'payoff of a closed-month purchase never touches the budget grid');

    // --- Creating a month AFTER its predecessor closed stores handoff immediately ---------
    closeMonth(db, B, '2026-10-03T12:00:00Z');
    const cId = createMonth(db, '2026-10', '2026-10-03T13:00:00Z');

    // B: income actual 450628 + 320195, no expenses -> carryover 770823.
    // B Medical projected 35000, unspent -> remaining 35000 -> 60000.
    // Non-rollover resets to base despite B's Groceries edit.
    const cCarryover = incomeRows(db, '2026-10').find((e) => e.kind === INCOME_KIND.CARRYOVER);
    assert.equal(cCarryover.projected, 770823);
    assert.equal(cCarryover.actual, 770823);
    assert.equal(accountByName(db, cId, 'Medical').projected, 60000);
    assert.equal(accountByName(db, cId, 'Groceries').projected, 15000);

    db.close();
});

test('reconciliation holds on a live database snapshot', () => {
    const { db, zach, macu, zachsCard } = seededDb();
    const aId = createMonth(db, '2026-08');
    const [check25, check10] = incomeRows(db, '2026-08');
    receiveIncome(db, check25.id, 320195, '2026-07-25');
    receiveIncome(db, check10.id, 150000, '2026-08-10');

    const groceries = accountByName(db, aId, 'Groceries');
    addTransaction(db,
        { monthId: aId, date: '2026-08-03', description: 'Groceries run',
          paymentMethodId: zachsCard, total: 4567, loggedBy: zach },
        [{ budget_account_id: groceries.id, amount: 4567 }]);
    addTransaction(db,
        { monthId: aId, date: '2026-08-04', description: 'Pending check',
          paymentMethodId: macu, total: 2500, status: STATUS.PENDING_MACU, loggedBy: zach },
        [{ budget_account_id: groceries.id, amount: 2500 }]);

    // disposableNow = 470195 - 7067; bank holds that plus pending + card balance.
    const disposable = 470195 - 7067;
    setAvailableInBank(db, aId, disposable + 2500 + 4567);

    const grid = deriveMonth(monthSnapshot(db, '2026-08'));
    assert.equal(grid.reconciliation.balanced, true);
    assert.equal(grid.reconciliation.discrepancy, 0);
    db.close();
});
