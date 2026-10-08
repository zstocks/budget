// Dev seed: throwaway database with the real templates (see seed-data.md)
// and a month of plausible fake activity. Rebuilds from scratch each run.
//
//     node seed-dev.js            # writes ./data/dev.db (or $BUDGET_DB_PATH)

import { rmSync } from 'node:fs';
import { openDb, DB_PATH_ENV_VAR } from './src/db/index.js';
import { createMonth, monthSnapshot } from './src/ledger/lifecycle.js';
import {
    addTransaction, payoffCard, receiveIncome, setAvailableInBank,
} from './src/ledger/store.js';
import { deriveMonth } from './src/ledger/derive.js';
import { STATUS } from './src/ledger/status.js';

const DEFAULT_DEV_DB = './data/dev.db';
const MONTH = '2026-10';

const dbPath = process.env[DB_PATH_ENV_VAR] ?? DEFAULT_DEV_DB;
if (dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
        rmSync(dbPath + suffix, { force: true });
    }
}
const db = openDb(dbPath);

// --- Structural seed (amounts from seed-data.md, converted to cents) -----------

const USERS = ['Zach', 'Jackie'];

// [name, type, owner or null]
const PAYMENT_METHODS = [
    ['MACU', 'checking', null],
    ["Jackie's Discover", 'credit', 'Jackie'],
    ["Zach's Discover", 'credit', 'Zach'],
    ['Citi Card', 'credit', null],
];

// [name, category, base cents, rollover]
const ACCOUNT_TEMPLATES = [
    ['Savings', 'Savings', 100000, 0],
    ["Jackie's Discover Card", 'Debt', 25000, 0],
    ["Zach's Discover Card", 'Debt', 20000, 0],
    ['Citi Card', 'Debt', 55000, 0],
    ['MACU Loan', 'Debt', 27500, 0],
    ["Zach's Student Loan", 'Debt', 23034, 0],
    ["Jackie's Student Loan", 'Debt', 39902, 0],
    ['Rent', 'Bills', 189300, 0],
    ['Car Insurance', 'Bills', 10953, 0],
    ['Gas', 'Bills', 5000, 0],
    ['Electric', 'Bills', 7500, 0],
    ['Conservice', 'Bills', 11500, 0],
    ['Phone', 'Bills', 30000, 0],
    ['Medical', 'Expenses', 25000, 1],
    ['Car Maintenance', 'Expenses', 4299, 0],
    ['Gasoline', 'Expenses', 10000, 0],
    ['Cats', 'Expenses', 15000, 0],
    ['Groceries', 'Expenses', 15000, 0],
    ['Food W1 (Zach)', 'Expenses', 22500, 0],
    ['Food W1 (Jackie)', 'Expenses', 22500, 0],
    ['Food W2 (Zach)', 'Expenses', 22500, 0],
    ['Food W2 (Jackie)', 'Expenses', 22500, 0],
    ['Food W3 (Zach)', 'Expenses', 22500, 0],
    ['Food W3 (Jackie)', 'Expenses', 22500, 0],
    ['Food W4 (Zach)', 'Expenses', 25000, 0],
    ['Food W4 (Jackie)', 'Expenses', 25000, 0],
    ['Merchandise', 'Expenses', 15000, 1],
    ['Grooming', 'Expenses', 25000, 1],
    ['Travel', 'Expenses', 0, 0],
    ['Gifts', 'Expenses', 0, 0],
    ['Software', 'Expenses', 25000, 0],
    ['Other Expenses', 'Expenses', 10000, 0],
    ["Jackie's Allowance", 'Leisure', 25000, 1],
    ["Zach's Allowance", 'Leisure', 25000, 1],
    ['Spotify', 'Leisure', 2038, 0],
    ['YouTube', 'Leisure', 3499, 0],
    ['Netflix', 'Leisure', 2896, 0],
    ['Coursera', 'Leisure', 5258, 0],
    ['Pimsleur', 'Leisure', 2252, 0],
    ['HBO', 'Leisure', 1979, 0],
    ['Adobe', 'Leisure', 7510, 0],
    ['Amazon Prime', 'Leisure', 2143, 0],
    ['Apple TV', 'Leisure', 1394, 0],
    ['Movies', 'Leisure', 15000, 0],
    ['Other Leisure', 'Leisure', 15000, 0],
];

// [label, day, funds_next_month, cents]
const INCOME_TEMPLATES = [
    ['Check (25th)', 25, 1, 320195],
    ['Check (6th)', 6, 0, 150000],
    ['Check (10th)', 10, 0, 320195],
    ['Check (21st)', 21, 0, 150000],
];

const userIds = new Map();
for (const name of USERS) {
    userIds.set(name, Number(
        db.prepare('INSERT INTO users (name) VALUES (?)').run(name).lastInsertRowid
    ));
}

const methodIds = new Map();
PAYMENT_METHODS.forEach(([name, type, owner], i) => {
    methodIds.set(name, Number(db.prepare(`
        INSERT INTO payment_methods (name, type, owner_user_id, sort_order)
        VALUES (?, ?, ?, ?)
    `).run(name, type, owner ? userIds.get(owner) : null, i).lastInsertRowid));
});

ACCOUNT_TEMPLATES.forEach(([name, category, base, rollover], i) => {
    db.prepare(`
        INSERT INTO account_templates (name, category, base_amount, rollover, sort_order)
        VALUES (?, ?, ?, ?, ?)
    `).run(name, category, base, rollover, i);
});

INCOME_TEMPLATES.forEach(([label, day, fundsNext, amount], i) => {
    db.prepare(`
        INSERT INTO income_templates (label, day_of_month, funds_next_month, amount, sort_order)
        VALUES (?, ?, ?, ?, ?)
    `).run(label, day, fundsNext, amount, i);
});

// --- One month of plausible fake activity ----------------------------------------

const monthId = createMonth(db, MONTH, '2026-09-28T09:00:00Z');

const accountId = (name) => db.prepare(
    'SELECT id FROM budget_accounts WHERE month_id = ? AND name = ?'
).get(monthId, name).id;
const incomeId = (label) => db.prepare(
    'SELECT id FROM income_entries WHERE budget_month = ? AND label = ?'
).get(MONTH, label).id;

// Checks received so far this month (the 25th landed back in September).
receiveIncome(db, incomeId('Check (25th)'), 320195, '2026-09-25');
receiveIncome(db, incomeId('Check (6th)'), 149812, '2026-10-06');

const zach = userIds.get('Zach');
const jackie = userIds.get('Jackie');

addTransaction(db,
    { monthId, date: '2026-10-01', description: 'Rent',
      paymentMethodId: methodIds.get('MACU'), total: 189300, loggedBy: zach },
    [{ budget_account_id: accountId('Rent'), amount: 189300 }]);

addTransaction(db,
    { monthId, date: '2026-10-02', description: 'Costco run',
      paymentMethodId: methodIds.get("Zach's Discover"), total: 14387, loggedBy: zach },
    [
        { budget_account_id: accountId('Groceries'), amount: 8942 },
        { budget_account_id: accountId('Cats'), amount: 3250 },
        { budget_account_id: accountId('Merchandise'), amount: 2195 },
    ]);

addTransaction(db,
    { monthId, date: '2026-10-03', description: 'Dinner out',
      paymentMethodId: methodIds.get("Jackie's Discover"), total: 6523, loggedBy: jackie },
    [{ budget_account_id: accountId('Food W1 | 1–7 (Jackie)'), amount: 6523 }]);

addTransaction(db,
    { monthId, date: '2026-10-04', description: 'Pharmacy',
      paymentMethodId: methodIds.get('Citi Card'), total: 4250, loggedBy: jackie },
    [{ budget_account_id: accountId('Medical'), amount: 4250 }]);

addTransaction(db,
    { monthId, date: '2026-10-05', description: 'Spotify',
      paymentMethodId: methodIds.get('MACU'), total: 2038,
      status: STATUS.PENDING_MACU, loggedBy: zach },
    [{ budget_account_id: accountId('Spotify'), amount: 2038 }]);

// Pay off Jackie's Discover — a status transition, not an expense.
payoffCard(db, methodIds.get("Jackie's Discover"));

// A refund on the Costco run.
addTransaction(db,
    { monthId, date: '2026-10-06', description: 'Costco return',
      paymentMethodId: methodIds.get("Zach's Discover"), total: -2195, loggedBy: zach },
    [{ budget_account_id: accountId('Merchandise'), amount: -2195 }]);

// Bank number chosen so the seed data reconciles exactly.
const preliminary = deriveMonth(monthSnapshot(db, MONTH));
setAvailableInBank(db, monthId,
    preliminary.disposableNow + preliminary.pendingMacu + preliminary.cardBalanceTotal);

// --- Summary --------------------------------------------------------------------

const grid = deriveMonth(monthSnapshot(db, MONTH));
const dollars = (cents) => (cents / 100).toFixed(2).padStart(12);

console.log(`Seeded ${dbPath} with month ${MONTH}\n`);
for (const [label, value] of [
    ['Income projected', grid.incomeProjected],
    ['Income actual', grid.incomeActual],
    ['Expenses projected', grid.expensesProjected],
    ['Expenses actual', grid.expensesActual],
    ['Unallocated income', grid.unallocatedIncome],
    ['Disposable now', grid.disposableNow],
    ['Pending MACU', grid.pendingMacu],
    ['Card balances', grid.cardBalanceTotal],
]) {
    console.log(`  ${label.padEnd(20)} ${dollars(value)}`);
}
console.log(`  ${'Reconciliation'.padEnd(20)} ${grid.reconciliation.balanced ? 'balanced' : `off by ${dollars(grid.reconciliation.discrepancy)}`}`);

db.close();
