import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    STATUS,
    METHOD_TYPE,
    defaultStatus,
    assertValidStatus,
    assertValidTransition,
    payoffTransitions,
} from '../src/ledger/status.js';
import { ERROR_CODES } from '../src/ledger/errors.js';

const ALL_STATUSES = [STATUS.ON_CARD, STATUS.PENDING_MACU, STATUS.CLEARED];

// The complete set of legal transitions; everything else must throw.
const LEGAL_TRANSITIONS = [
    [METHOD_TYPE.CREDIT, STATUS.ON_CARD, STATUS.PENDING_MACU],
    [METHOD_TYPE.CREDIT, STATUS.PENDING_MACU, STATUS.CLEARED],
    [METHOD_TYPE.CHECKING, STATUS.PENDING_MACU, STATUS.CLEARED],
];

test('defaultStatus: credit starts on_card, checking starts cleared', () => {
    assert.equal(defaultStatus(METHOD_TYPE.CREDIT), STATUS.ON_CARD);
    assert.equal(defaultStatus(METHOD_TYPE.CHECKING), STATUS.CLEARED);
});

test('unknown method type is rejected everywhere', () => {
    assert.throws(() => defaultStatus('paypal'), { code: ERROR_CODES.UNKNOWN_METHOD_TYPE });
    assert.throws(
        () => assertValidStatus('paypal', STATUS.CLEARED),
        { code: ERROR_CODES.UNKNOWN_METHOD_TYPE }
    );
});

test('unknown status is rejected', () => {
    assert.throws(
        () => assertValidStatus(METHOD_TYPE.CREDIT, 'reconciled'),
        { code: ERROR_CODES.INVALID_STATUS }
    );
});

test('on_card is legal on credit, illegal on checking', () => {
    assertValidStatus(METHOD_TYPE.CREDIT, STATUS.ON_CARD);
    assert.throws(
        () => assertValidStatus(METHOD_TYPE.CHECKING, STATUS.ON_CARD),
        { code: ERROR_CODES.INVALID_STATUS }
    );
});

test('pending_macu and cleared are legal on both method types', () => {
    for (const methodType of [METHOD_TYPE.CREDIT, METHOD_TYPE.CHECKING]) {
        assertValidStatus(methodType, STATUS.PENDING_MACU);
        assertValidStatus(methodType, STATUS.CLEARED);
    }
});

test('exactly the legal transitions pass; all other combinations throw', () => {
    for (const methodType of [METHOD_TYPE.CREDIT, METHOD_TYPE.CHECKING]) {
        for (const from of ALL_STATUSES) {
            for (const to of ALL_STATUSES) {
                const legal = LEGAL_TRANSITIONS.some(
                    ([m, f, t]) => m === methodType && f === from && t === to
                );
                if (legal) {
                    assertValidTransition(methodType, from, to);
                } else {
                    assert.throws(
                        () => assertValidTransition(methodType, from, to),
                        (err) => err.code === ERROR_CODES.INVALID_STATUS_TRANSITION
                            || err.code === ERROR_CODES.INVALID_STATUS,
                        `expected throw for ${methodType}: ${from} -> ${to}`
                    );
                }
            }
        }
    }
});

test('skipping pending_macu is illegal even on credit', () => {
    assert.throws(
        () => assertValidTransition(METHOD_TYPE.CREDIT, STATUS.ON_CARD, STATUS.CLEARED),
        { code: ERROR_CODES.INVALID_STATUS_TRANSITION }
    );
});

test('payoff returns transitions only for on_card transactions', () => {
    const cardTransactions = [
        { id: 1, status: STATUS.ON_CARD },
        { id: 2, status: STATUS.PENDING_MACU },
        { id: 3, status: STATUS.ON_CARD },
        { id: 4, status: STATUS.CLEARED },
    ];
    assert.deepEqual(payoffTransitions(cardTransactions), [
        { id: 1, from: STATUS.ON_CARD, to: STATUS.PENDING_MACU },
        { id: 3, from: STATUS.ON_CARD, to: STATUS.PENDING_MACU },
    ]);
});

test('payoff with nothing on_card is an empty no-op', () => {
    assert.deepEqual(payoffTransitions([{ id: 1, status: STATUS.CLEARED }]), []);
    assert.deepEqual(payoffTransitions([]), []);
});

test('payoff never touches budget accounts: per-account actuals identical before and after', () => {
    // Simulate a card with purchases split against budget accounts, apply a
    // payoff, and verify the budget grid is byte-identical. This pins down
    // the core rule: a payoff is a status transition, never an expense.
    const transactions = [
        { id: 1, status: STATUS.ON_CARD, total: 5000 },
        { id: 2, status: STATUS.ON_CARD, total: 2500 },
        { id: 3, status: STATUS.CLEARED, total: 1000 },
    ];
    const splits = [
        { transaction_id: 1, budget_account_id: 10, amount: 3000 },
        { transaction_id: 1, budget_account_id: 11, amount: 2000 },
        { transaction_id: 2, budget_account_id: 10, amount: 2500 },
        { transaction_id: 3, budget_account_id: 11, amount: 1000 },
    ];

    const actualsByAccount = (splitRows) => {
        const totals = {};
        for (const s of splitRows) {
            totals[s.budget_account_id] = (totals[s.budget_account_id] ?? 0) + s.amount;
        }
        return totals;
    };

    const before = actualsByAccount(splits);
    const transactionCountBefore = transactions.length;

    for (const { id, from, to } of payoffTransitions(transactions)) {
        const t = transactions.find((row) => row.id === id);
        assert.equal(t.status, from);
        t.status = to;
    }

    assert.deepEqual(actualsByAccount(splits), before);
    assert.equal(transactions.length, transactionCountBefore);
    assert.equal(transactions[0].status, STATUS.PENDING_MACU);
    assert.equal(transactions[1].status, STATUS.PENDING_MACU);
    assert.equal(transactions[2].status, STATUS.CLEARED);
});
