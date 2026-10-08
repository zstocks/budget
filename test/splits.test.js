import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSplits } from '../src/ledger/splits.js';
import { ERROR_CODES } from '../src/ledger/errors.js';

const MONTH_ID = 1;
const OTHER_MONTH_ID = 2;

const ACCOUNTS = new Map([
    [10, { id: 10, month_id: MONTH_ID }],
    [11, { id: 11, month_id: MONTH_ID }],
    [12, { id: 12, month_id: MONTH_ID }],
    [99, { id: 99, month_id: OTHER_MONTH_ID }],
]);

function tx(total) {
    return { total, monthId: MONTH_ID };
}

test('single split equal to total passes', () => {
    validateSplits(tx(4599), [{ budget_account_id: 10, amount: 4599 }], ACCOUNTS);
});

test('multi-account split summing exactly passes', () => {
    validateSplits(tx(10000), [
        { budget_account_id: 10, amount: 2500 },
        { budget_account_id: 11, amount: 2500 },
        { budget_account_id: 12, amount: 5000 },
    ], ACCOUNTS);
});

test('sum off by one cent is rejected', () => {
    assert.throws(
        () => validateSplits(tx(10000), [
            { budget_account_id: 10, amount: 4999 },
            { budget_account_id: 11, amount: 5000 },
        ], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_SUM_MISMATCH }
    );
});

test('sum mismatch reports the difference', () => {
    try {
        validateSplits(tx(10000), [{ budget_account_id: 10, amount: 10001 }], ACCOUNTS);
        assert.fail('expected throw');
    } catch (err) {
        assert.equal(err.code, ERROR_CODES.SPLIT_SUM_MISMATCH);
        assert.deepEqual(err.details, { expected: 10000, actual: 10001, difference: 1 });
    }
});

test('empty split list is rejected', () => {
    assert.throws(
        () => validateSplits(tx(500), [], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_EMPTY }
    );
});

test('missing split list is rejected', () => {
    assert.throws(
        () => validateSplits(tx(500), undefined, ACCOUNTS),
        { code: ERROR_CODES.SPLIT_EMPTY }
    );
});

test('zero-amount split is rejected', () => {
    assert.throws(
        () => validateSplits(tx(500), [
            { budget_account_id: 10, amount: 500 },
            { budget_account_id: 11, amount: 0 },
        ], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_ZERO_AMOUNT }
    );
});

test('non-integer amount is rejected (float dollars sneaking in)', () => {
    assert.throws(
        () => validateSplits(tx(500), [{ budget_account_id: 10, amount: 5.0001 }], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_NON_INTEGER_AMOUNT }
    );
});

test('negative total refund with matching negative split passes', () => {
    validateSplits(tx(-4599), [{ budget_account_id: 10, amount: -4599 }], ACCOUNTS);
});

test('mixed-sign splits summing to total pass (purchase with same-receipt return)', () => {
    validateSplits(tx(2000), [
        { budget_account_id: 10, amount: 3000 },
        { budget_account_id: 11, amount: -1000 },
    ], ACCOUNTS);
});

test('duplicate account across splits is rejected', () => {
    assert.throws(
        () => validateSplits(tx(1000), [
            { budget_account_id: 10, amount: 400 },
            { budget_account_id: 10, amount: 600 },
        ], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_DUPLICATE_ACCOUNT }
    );
});

test('unknown account is rejected', () => {
    assert.throws(
        () => validateSplits(tx(1000), [{ budget_account_id: 777, amount: 1000 }], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_UNKNOWN_ACCOUNT }
    );
});

test('account from a different month is rejected', () => {
    assert.throws(
        () => validateSplits(tx(1000), [{ budget_account_id: 99, amount: 1000 }], ACCOUNTS),
        { code: ERROR_CODES.SPLIT_WRONG_MONTH }
    );
});
