// Month lifecycle: create, live-derived snapshot, close.
//
// Creation and close are separate explicit events; overlap is the NORMAL
// case (September is created days before August closes). While the
// previous month is still open, the new month's Carryover and rollover
// projections are LIVE-DERIVED from it — monthSnapshot() applies those
// overrides on top of the stored placeholder rows, so a late August
// transaction updates September's numbers without any stored state.
// Close then writes the live values down as the next month's own stored,
// editable values, and the closed month becomes read-only (enforced in
// store.js).

import { LedgerError, ERROR_CODES } from './errors.js';
import { deriveMonth, actualsByAccount } from './derive.js';
import { carryover, rolloverProjected, remaining, nextProjections } from './rollover.js';

export const MONTH_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });
export const INCOME_KIND = Object.freeze({ CHECK: 'check', CARRYOVER: 'carryover', OTHER: 'other' });

// Carryover/Other sort after the check rows regardless of template count.
const CARRYOVER_SORT_ORDER = 100;
const OTHER_SORT_ORDER = 101;

// --- Month-string helpers -----------------------------------------------------

export function nextMonth(month) {
    const [year, m] = month.split('-').map(Number);
    return m === 12
        ? `${year + 1}-01`
        : `${year}-${String(m + 1).padStart(2, '0')}`;
}

export function prevMonth(month) {
    const [year, m] = month.split('-').map(Number);
    return m === 1
        ? `${year - 1}-12`
        : `${year}-${String(m - 1).padStart(2, '0')}`;
}

export function daysInMonth(month) {
    const [year, m] = month.split('-').map(Number);
    return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

// Food-week template names ("Food W1 (Zach)") get per-month date-range
// labels ("Food W1 | 1–7 (Zach)"); W4 runs through month-end.
const FOOD_WEEK_PATTERN = /^Food W([1-4]) \((.+)\)$/;
const FOOD_WEEK_LENGTH = 7;
const LAST_FOOD_WEEK = 4;

export function instanceName(templateName, month) {
    const match = templateName.match(FOOD_WEEK_PATTERN);
    if (!match) {
        return templateName;
    }
    const week = Number(match[1]);
    const person = match[2];
    const start = (week - 1) * FOOD_WEEK_LENGTH + 1;
    const end = week === LAST_FOOD_WEEK ? daysInMonth(month) : week * FOOD_WEEK_LENGTH;
    return `Food W${week} | ${start}–${end} (${person})`;
}

// --- Queries shared by create/snapshot/close ------------------------------------

function monthRowByName(db, month) {
    return db.prepare('SELECT * FROM months WHERE month = ?').get(month) ?? null;
}

function accountsForMonth(db, monthId) {
    return db.prepare(
        'SELECT * FROM budget_accounts WHERE month_id = ? ORDER BY sort_order, id'
    ).all(monthId);
}

function splitsForMonth(db, monthId) {
    return db.prepare(`
        SELECT ts.* FROM transaction_splits ts
        JOIN transactions t ON t.id = ts.transaction_id
        WHERE t.month_id = ?
    `).all(monthId);
}

function activeTemplates(db) {
    return db.prepare(
        'SELECT * FROM account_templates WHERE active = 1 ORDER BY sort_order, id'
    ).all();
}

function prevAccountsByTemplate(db, prevMonthId) {
    return new Map(
        accountsForMonth(db, prevMonthId)
            .filter((a) => a.template_id !== null)
            .map((a) => [a.template_id, a])
    );
}

/** carryover + per-template rollover projections derived from one month's CURRENT state. */
function derivedHandoff(db, sourceMonthRow) {
    const snapshot = monthSnapshot(db, sourceMonthRow.month);
    const grid = deriveMonth(snapshot);
    const projections = nextProjections(
        activeTemplates(db),
        prevAccountsByTemplate(db, sourceMonthRow.id),
        actualsByAccount(splitsForMonth(db, sourceMonthRow.id))
    );
    return {
        carryoverAmount: carryover(grid.incomeActual, grid.expensesActual),
        projectionsByTemplate: projections,
    };
}

// --- Create ----------------------------------------------------------------------

/**
 * Create a month: instantiate accounts from active templates, income rows
 * from income_templates (adopting an already-recorded next-month-tagged
 * check), plus Carryover and Other rows.
 *
 * If the previous month exists and is CLOSED, its stored handoff values
 * are computed and written now. If it is still OPEN, placeholders are
 * stored (template base / carryover 0) and monthSnapshot() live-derives
 * until close writes the real values down.
 */
export function createMonth(db, month, now = new Date().toISOString()) {
    if (monthRowByName(db, month)) {
        throw new LedgerError(ERROR_CODES.MONTH_EXISTS, `Month ${month} already exists`, { month });
    }

    const prevRow = monthRowByName(db, prevMonth(month));
    const prevClosed = prevRow !== null && prevRow.status === MONTH_STATUS.CLOSED;
    const handoff = prevClosed ? derivedHandoff(db, prevRow) : null;

    return db.transaction(() => {
        const { lastInsertRowid: monthId } = db.prepare(
            'INSERT INTO months (month, status, created_at) VALUES (?, ?, ?)'
        ).run(month, MONTH_STATUS.OPEN, now);

        const insertAccount = db.prepare(`
            INSERT INTO budget_accounts (month_id, template_id, name, category, projected, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const template of activeTemplates(db)) {
            const projected = handoff?.projectionsByTemplate.get(template.id) ?? template.base_amount;
            insertAccount.run(
                monthId, template.id, instanceName(template.name, month),
                template.category, projected, template.sort_order
            );
        }

        const insertIncome = db.prepare(`
            INSERT INTO income_entries (budget_month, kind, label, projected, actual, received_date, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const alreadyRecordedChecks = db.prepare(
            'SELECT COUNT(*) AS n FROM income_entries WHERE budget_month = ? AND kind = ?'
        ).get(month, INCOME_KIND.CHECK).n;

        const incomeTemplates = db.prepare(
            'SELECT * FROM income_templates WHERE active = 1 ORDER BY sort_order, id'
        ).all();
        for (const t of incomeTemplates) {
            if (t.funds_next_month && alreadyRecordedChecks > 0) {
                continue;   // adopt the check recorded when it physically arrived
            }
            insertIncome.run(month, INCOME_KIND.CHECK, t.label, t.amount, null, null, t.sort_order);
        }

        const carryoverAmount = handoff?.carryoverAmount ?? 0;
        insertIncome.run(
            month, INCOME_KIND.CARRYOVER, 'Carryover',
            carryoverAmount, prevClosed ? carryoverAmount : null, prevClosed ? now : null,
            CARRYOVER_SORT_ORDER
        );
        insertIncome.run(month, INCOME_KIND.OTHER, 'Other', 0, null, null, OTHER_SORT_ORDER);

        return Number(monthId);
    })();
}

// --- Snapshot (with live overrides) -------------------------------------------------

/**
 * Assemble the deriveMonth() snapshot for a month. While the previous
 * month is still open, the Carryover row and rollover accounts' projected
 * are overridden with values live-derived from it; rows are copied, never
 * mutated, and nothing derived is written back.
 */
export function monthSnapshot(db, month) {
    const monthRow = monthRowByName(db, month);
    if (!monthRow) {
        throw new LedgerError(ERROR_CODES.MONTH_NOT_FOUND, `No month ${month}`, { month });
    }

    let budgetAccounts = accountsForMonth(db, monthRow.id);
    let incomeEntries = db.prepare('SELECT * FROM income_entries ORDER BY sort_order, id').all();

    const prevRow = monthRowByName(db, prevMonth(month));
    if (prevRow && prevRow.status === MONTH_STATUS.OPEN) {
        const live = liveHandoff(db, prevRow, prevMonth(month));
        incomeEntries = incomeEntries.map((e) => (
            e.budget_month === month && e.kind === INCOME_KIND.CARRYOVER
                ? { ...e, projected: live.carryoverAmount, actual: live.carryoverAmount }
                : e
        ));
        budgetAccounts = budgetAccounts.map((a) => (
            live.projectionsByTemplate.has(a.template_id)
                ? { ...a, projected: live.projectionsByTemplate.get(a.template_id) }
                : a
        ));
    }

    return {
        month,
        availableInBank: monthRow.available_in_bank,
        incomeEntries,
        budgetAccounts,
        transactions: db.prepare('SELECT * FROM transactions').all(),
        splits: splitsForMonth(db, monthRow.id),
        paymentMethods: db.prepare('SELECT * FROM payment_methods').all(),
    };
}

// Like derivedHandoff but restricted to ROLLOVER templates: while the
// previous month is open, non-rollover projections in the new month are
// already independent and must not be overridden.
function liveHandoff(db, prevRow, prevMonthName) {
    const { carryoverAmount } = derivedHandoff(db, prevRow);
    const prevAccounts = prevAccountsByTemplate(db, prevRow.id);
    const prevActuals = actualsByAccount(splitsForMonth(db, prevRow.id));

    const projectionsByTemplate = new Map();
    for (const template of activeTemplates(db)) {
        const prevAccount = prevAccounts.get(template.id);
        if (!template.rollover || !prevAccount) {
            continue;
        }
        projectionsByTemplate.set(template.id, rolloverProjected(
            template.base_amount,
            remaining(prevAccount.projected, prevActuals.get(prevAccount.id) ?? 0)
        ));
    }
    return { carryoverAmount, projectionsByTemplate };
}

// --- Close ----------------------------------------------------------------------------

/**
 * Close a month: write its live-derived carryover and rollover values
 * down as the NEXT month's own stored, editable values (if that month
 * exists), then mark it closed. Only rollover accounts' projected are
 * written — any edits already made to the next month's other accounts
 * are its own business.
 */
export function closeMonth(db, month, now = new Date().toISOString()) {
    const monthRow = monthRowByName(db, month);
    if (!monthRow) {
        throw new LedgerError(ERROR_CODES.MONTH_NOT_FOUND, `No month ${month}`, { month });
    }
    if (monthRow.status !== MONTH_STATUS.OPEN) {
        throw new LedgerError(ERROR_CODES.MONTH_CLOSED, `Month ${month} is already closed`, { month });
    }
    const prevRow = monthRowByName(db, prevMonth(month));
    if (prevRow && prevRow.status === MONTH_STATUS.OPEN) {
        throw new LedgerError(
            ERROR_CODES.MONTH_PREV_OPEN,
            `Close ${prevMonth(month)} before closing ${month}`,
            { month, prevMonth: prevMonth(month) }
        );
    }

    const { carryoverAmount, projectionsByTemplate } = derivedHandoff(db, monthRow);
    const nextRow = monthRowByName(db, nextMonth(month));

    db.transaction(() => {
        if (nextRow) {
            db.prepare(`
                UPDATE income_entries SET projected = ?, actual = ?, received_date = ?
                WHERE budget_month = ? AND kind = ?
            `).run(carryoverAmount, carryoverAmount, now, nextRow.month, INCOME_KIND.CARRYOVER);

            const rolloverTemplateIds = new Set(
                activeTemplates(db).filter((t) => t.rollover).map((t) => t.id)
            );
            const updateProjected = db.prepare(
                'UPDATE budget_accounts SET projected = ? WHERE month_id = ? AND template_id = ?'
            );
            for (const [templateId, projected] of projectionsByTemplate) {
                if (rolloverTemplateIds.has(templateId)) {
                    updateProjected.run(projected, nextRow.id, templateId);
                }
            }
        }
        db.prepare('UPDATE months SET status = ?, closed_at = ? WHERE id = ?')
            .run(MONTH_STATUS.CLOSED, now, monthRow.id);
    })();

    return { carryoverAmount, projectionsByTemplate };
}
