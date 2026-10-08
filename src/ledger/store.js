// Write layer: the only path through which ledger rows change. Every
// budget-affecting write re-validates the pure invariants (split sums,
// status legality) and enforces closed-month read-only.
//
// Deliberate exception: STATUS TRANSITIONS are allowed on transactions
// whose month is closed. They describe the physical state of cards and
// the bank (a card can be paid off in September for an August purchase),
// and by construction they never touch the budget grid.

import { LedgerError, ERROR_CODES } from './errors.js';
import { validateSplits } from './splits.js';
import {
    STATUS,
    defaultStatus,
    assertValidStatus,
    assertValidTransition,
    payoffTransitions,
} from './status.js';

export function getMonthRow(db, monthId) {
    const row = db.prepare('SELECT * FROM months WHERE id = ?').get(monthId);
    if (!row) {
        throw new LedgerError(
            ERROR_CODES.MONTH_NOT_FOUND,
            `No month with id ${monthId}`,
            { monthId }
        );
    }
    return row;
}

export function assertMonthOpen(db, monthId) {
    const row = getMonthRow(db, monthId);
    if (row.status !== 'open') {
        throw new LedgerError(
            ERROR_CODES.MONTH_CLOSED,
            `Month ${row.month} is closed and read-only`,
            { monthId, month: row.month }
        );
    }
    return row;
}

function assertIntegerCents(amount, what) {
    if (!Number.isInteger(amount)) {
        throw new LedgerError(
            ERROR_CODES.NON_INTEGER_AMOUNT,
            `${what} must be integer cents, got ${amount}`,
            { amount }
        );
    }
}

/**
 * Log a transaction with its splits, atomically. Status defaults by
 * method type (credit -> on_card, checking -> cleared).
 */
export function addTransaction(db, transaction, splits) {
    const {
        monthId, date, description, paymentMethodId, total, loggedBy,
        status: requestedStatus,
    } = transaction;

    assertMonthOpen(db, monthId);
    assertIntegerCents(total, 'Transaction total');

    const method = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(paymentMethodId);
    if (!method) {
        throw new LedgerError(
            ERROR_CODES.UNKNOWN_PAYMENT_METHOD,
            `No payment method with id ${paymentMethodId}`,
            { paymentMethodId }
        );
    }
    const status = requestedStatus ?? defaultStatus(method.type);
    assertValidStatus(method.type, status);

    const accounts = db.prepare('SELECT id, month_id FROM budget_accounts WHERE month_id = ?')
        .all(monthId);
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    validateSplits({ total, monthId }, splits, accountsById);

    return db.transaction(() => {
        const { lastInsertRowid } = db.prepare(`
            INSERT INTO transactions
                (month_id, date, description, payment_method_id, total, status, logged_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(monthId, date, description, paymentMethodId, total, status, loggedBy,
            new Date().toISOString());

        const insertSplit = db.prepare(`
            INSERT INTO transaction_splits (transaction_id, budget_account_id, amount)
            VALUES (?, ?, ?)
        `);
        for (const split of splits) {
            insertSplit.run(lastInsertRowid, split.budget_account_id, split.amount);
        }
        return Number(lastInsertRowid);
    })();
}

/** Move one transaction forward in the status machine (any month). */
export function transitionStatus(db, transactionId, to) {
    const row = db.prepare(`
        SELECT t.id, t.status, pm.type AS method_type
        FROM transactions t
        JOIN payment_methods pm ON pm.id = t.payment_method_id
        WHERE t.id = ?
    `).get(transactionId);
    if (!row) {
        throw new LedgerError(
            ERROR_CODES.UNKNOWN_TRANSACTION,
            `No transaction with id ${transactionId}`,
            { transactionId }
        );
    }
    assertValidTransition(row.method_type, row.status, to);
    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(to, transactionId);
}

/**
 * Pay off a card: bulk on_card -> pending_macu on that card's rows.
 * Never inserts rows, never touches splits — crossing months is fine.
 * Returns the affected transaction ids.
 */
export function payoffCard(db, paymentMethodId) {
    const onCard = db.prepare(
        'SELECT id, status FROM transactions WHERE payment_method_id = ? AND status = ?'
    ).all(paymentMethodId, STATUS.ON_CARD);

    const update = db.prepare('UPDATE transactions SET status = ? WHERE id = ?');
    return db.transaction(() => {
        const ids = [];
        for (const { id, to } of payoffTransitions(onCard)) {
            update.run(to, id);
            ids.push(id);
        }
        return ids;
    })();
}

export function setAvailableInBank(db, monthId, amount) {
    assertMonthOpen(db, monthId);
    assertIntegerCents(amount, 'available_in_bank');
    db.prepare('UPDATE months SET available_in_bank = ? WHERE id = ?').run(amount, monthId);
}

export function setAccountProjected(db, budgetAccountId, projected) {
    const account = db.prepare('SELECT id, month_id FROM budget_accounts WHERE id = ?')
        .get(budgetAccountId);
    if (!account) {
        throw new LedgerError(
            ERROR_CODES.UNKNOWN_BUDGET_ACCOUNT,
            `No budget account with id ${budgetAccountId}`,
            { budgetAccountId }
        );
    }
    assertMonthOpen(db, account.month_id);
    assertIntegerCents(projected, 'projected');
    db.prepare('UPDATE budget_accounts SET projected = ? WHERE id = ?')
        .run(projected, budgetAccountId);
}

function assertBudgetMonthWritable(db, budgetMonth) {
    // Income entries can target a month whose row doesn't exist yet (the
    // day-25 check). Only an EXISTING, CLOSED month rejects the write.
    const monthRow = db.prepare('SELECT id, status FROM months WHERE month = ?').get(budgetMonth);
    if (monthRow && monthRow.status !== 'open') {
        throw new LedgerError(
            ERROR_CODES.MONTH_CLOSED,
            `Month ${budgetMonth} is closed and read-only`,
            { month: budgetMonth }
        );
    }
}

/**
 * Record an income entry directly — used for the day-25 check received
 * before its budget month's row exists. Month creation later adopts it.
 */
export function addIncomeEntry(db, entry) {
    const {
        budgetMonth, kind = 'check', label,
        projected = 0, actual = null, receivedDate = null, sortOrder = 0,
    } = entry;

    assertBudgetMonthWritable(db, budgetMonth);
    assertIntegerCents(projected, 'projected');
    if (actual !== null) {
        assertIntegerCents(actual, 'actual');
    }
    if ((actual === null) !== (receivedDate === null)) {
        throw new LedgerError(
            ERROR_CODES.INCOME_ACTUAL_DATE_MISMATCH,
            'actual and receivedDate must be set together or not at all',
            { actual, receivedDate }
        );
    }

    const { lastInsertRowid } = db.prepare(`
        INSERT INTO income_entries (budget_month, kind, label, projected, actual, received_date, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(budgetMonth, kind, label, projected, actual, receivedDate, sortOrder);
    return Number(lastInsertRowid);
}

/** Mark an income entry received: actual and received_date set together. */
export function receiveIncome(db, incomeEntryId, actual, receivedDate) {
    const entry = db.prepare('SELECT id, budget_month FROM income_entries WHERE id = ?')
        .get(incomeEntryId);
    if (!entry) {
        throw new LedgerError(
            ERROR_CODES.UNKNOWN_INCOME_ENTRY,
            `No income entry with id ${incomeEntryId}`,
            { incomeEntryId }
        );
    }
    assertBudgetMonthWritable(db, entry.budget_month);
    assertIntegerCents(actual, 'actual');
    db.prepare('UPDATE income_entries SET actual = ?, received_date = ? WHERE id = ?')
        .run(actual, receivedDate, incomeEntryId);
}
