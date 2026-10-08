// Split validation — pure, no database access.
//
// A transaction's splits MUST sum exactly to its total (integer cents, no
// tolerance), and every split's account must belong to the transaction's
// month. Negative amounts are allowed (refunds), including mixed signs on
// one transaction; zero-amount splits are rejected as noise.

import { LedgerError, ERROR_CODES } from './errors.js';

/**
 * Validate a transaction's splits. Throws LedgerError on the first
 * violation; returns undefined when valid.
 *
 * @param {{ total: number, monthId: number }} transaction
 * @param {Array<{ budget_account_id: number, amount: number }>} splits
 * @param {Map<number, { id: number, month_id: number }>} accountsById
 *        The candidate budget_accounts rows, keyed by id.
 */
export function validateSplits({ total, monthId }, splits, accountsById) {
    if (!Array.isArray(splits) || splits.length === 0) {
        throw new LedgerError(
            ERROR_CODES.SPLIT_EMPTY,
            'A transaction must have at least one split'
        );
    }

    const seenAccountIds = new Set();
    let sum = 0;

    for (const split of splits) {
        const { budget_account_id: accountId, amount } = split;

        if (!Number.isInteger(amount)) {
            throw new LedgerError(
                ERROR_CODES.SPLIT_NON_INTEGER_AMOUNT,
                `Split amount must be integer cents, got ${amount}`,
                { accountId, amount }
            );
        }
        if (amount === 0) {
            throw new LedgerError(
                ERROR_CODES.SPLIT_ZERO_AMOUNT,
                'Split amount must not be zero',
                { accountId }
            );
        }
        if (seenAccountIds.has(accountId)) {
            throw new LedgerError(
                ERROR_CODES.SPLIT_DUPLICATE_ACCOUNT,
                `Account ${accountId} appears in more than one split`,
                { accountId }
            );
        }
        seenAccountIds.add(accountId);

        const account = accountsById.get(accountId);
        if (!account) {
            throw new LedgerError(
                ERROR_CODES.SPLIT_UNKNOWN_ACCOUNT,
                `Split references unknown budget account ${accountId}`,
                { accountId }
            );
        }
        if (account.month_id !== monthId) {
            throw new LedgerError(
                ERROR_CODES.SPLIT_WRONG_MONTH,
                `Account ${accountId} belongs to month ${account.month_id}, not ${monthId}`,
                { accountId, accountMonthId: account.month_id, transactionMonthId: monthId }
            );
        }

        sum += amount;
    }

    if (sum !== total) {
        throw new LedgerError(
            ERROR_CODES.SPLIT_SUM_MISMATCH,
            `Splits sum to ${sum}, transaction total is ${total}`,
            { expected: total, actual: sum, difference: sum - total }
        );
    }
}
