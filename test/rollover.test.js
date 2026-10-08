import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remaining, rolloverProjected, carryover, nextProjections } from '../src/ledger/rollover.js';

const MEDICAL_BASE = 25000;

test('unspent remainder carries on top of the template base', () => {
    // Projected 250.00, spent 100.00 -> next month 400.00
    assert.equal(rolloverProjected(MEDICAL_BASE, remaining(25000, 10000)), 40000);
});

test('fully spent month resets to base', () => {
    assert.equal(rolloverProjected(MEDICAL_BASE, remaining(25000, 25000)), MEDICAL_BASE);
});

test('negative remainder never carries: overspent month resets to base', () => {
    // Spent 300.00 against 250.00 -> next month is 250.00, not 200.00
    assert.equal(rolloverProjected(MEDICAL_BASE, remaining(25000, 30000)), MEDICAL_BASE);
});

test('edited-projected trap: a one-off bump, fully spent, resets to TEMPLATE base', () => {
    // Zach bumps Medical to 400.00 for a known expense and spends it all.
    // remaining = 0, and next month must be the template's 250.00 — the
    // wrong formula (building on last month's edited projected) gives 400.00.
    const editedProjected = 40000;
    assert.equal(
        rolloverProjected(MEDICAL_BASE, remaining(editedProjected, 40000)),
        MEDICAL_BASE
    );
});

test('edited-projected bump that goes unspent does carry — the allocation was real', () => {
    // Bumped to 400.00, spent 250.00 -> remaining 150.00 -> next 400.00
    assert.equal(
        rolloverProjected(MEDICAL_BASE, remaining(40000, 25000)),
        40000
    );
});

test('carryover is income actual minus expenses actual', () => {
    assert.equal(carryover(520195, 206367), 313828);
    assert.equal(carryover(100000, 150000), -50000);  // negative carryover is legal
});

test('nextProjections: rollover carries, non-rollover resets, inactive skipped, missing instance -> base', () => {
    const templates = [
        { id: 1, base_amount: 25000, rollover: 1, active: 1 },  // Medical: carries
        { id: 2, base_amount: 15000, rollover: 0, active: 1 },  // Groceries: resets
        { id: 3, base_amount: 9999, rollover: 1, active: 0 },   // retired: skipped
        { id: 4, base_amount: 15000, rollover: 1, active: 1 },  // new this month: no prev instance
    ];
    const prevAccounts = new Map([
        [1, { id: 10, projected: 25000 }],
        [2, { id: 11, projected: 15000 }],
        [3, { id: 12, projected: 9999 }],
    ]);
    const prevActuals = new Map([
        [10, 10000],   // Medical: 150.00 left
        [11, 2000],    // Groceries: leftover must NOT carry (non-rollover)
    ]);

    const projections = nextProjections(templates, prevAccounts, prevActuals);
    assert.deepEqual(projections, new Map([
        [1, 40000],
        [2, 15000],
        [4, 15000],
    ]));
});

test('nextProjections treats a rollover account with no splits as fully unspent', () => {
    const templates = [{ id: 1, base_amount: 25000, rollover: 1, active: 1 }];
    const prevAccounts = new Map([[1, { id: 10, projected: 25000 }]]);
    const projections = nextProjections(templates, prevAccounts, new Map());
    assert.equal(projections.get(1), 50000);
});
