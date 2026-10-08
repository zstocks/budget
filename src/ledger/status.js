// Credit status machine — pure legality rules, no database access.
//
//     on_card -> pending_macu -> cleared
//
// 'on_card' is only legal on credit-type payment methods. Transitions are
// strictly forward and adjacent-only: even a same-day card payoff passes
// through pending_macu, because the payment physically pends at MACU.
// Paying off a card is a bulk STATUS TRANSITION on existing rows — never a
// new transaction, never an expense, never a touch on budget accounts.
//
// Balance sums (card_balance, pending_macu totals) are derived values and
// live in the derivation module, not here.

import { LedgerError, ERROR_CODES } from './errors.js';

export const STATUS = Object.freeze({
    ON_CARD: 'on_card',
    PENDING_MACU: 'pending_macu',
    CLEARED: 'cleared',
});

export const METHOD_TYPE = Object.freeze({
    CHECKING: 'checking',
    CREDIT: 'credit',
});

const STATUS_ORDER = Object.freeze([STATUS.ON_CARD, STATUS.PENDING_MACU, STATUS.CLEARED]);
const ADJACENT_STEP = 1;

function assertKnownMethodType(methodType) {
    if (methodType !== METHOD_TYPE.CHECKING && methodType !== METHOD_TYPE.CREDIT) {
        throw new LedgerError(
            ERROR_CODES.UNKNOWN_METHOD_TYPE,
            `Unknown payment method type '${methodType}'`,
            { methodType }
        );
    }
}

/** Default status for a newly logged transaction on this method type. */
export function defaultStatus(methodType) {
    assertKnownMethodType(methodType);
    return methodType === METHOD_TYPE.CREDIT ? STATUS.ON_CARD : STATUS.CLEARED;
}

/**
 * A status is legal for a method type if it exists and, for 'on_card',
 * the method is credit. Any legal status is accepted at creation (so a
 * back-entered, already-cleared credit purchase is fine).
 */
export function assertValidStatus(methodType, status) {
    assertKnownMethodType(methodType);
    if (!STATUS_ORDER.includes(status)) {
        throw new LedgerError(
            ERROR_CODES.INVALID_STATUS,
            `Unknown transaction status '${status}'`,
            { methodType, status }
        );
    }
    if (status === STATUS.ON_CARD && methodType !== METHOD_TYPE.CREDIT) {
        throw new LedgerError(
            ERROR_CODES.INVALID_STATUS,
            `Status 'on_card' is only legal on credit-type methods, got '${methodType}'`,
            { methodType, status }
        );
    }
}

/** Forward-only, adjacent-only; both endpoints must be legal for the method. */
export function assertValidTransition(methodType, from, to) {
    assertValidStatus(methodType, from);
    assertValidStatus(methodType, to);
    const step = STATUS_ORDER.indexOf(to) - STATUS_ORDER.indexOf(from);
    if (step !== ADJACENT_STEP) {
        throw new LedgerError(
            ERROR_CODES.INVALID_STATUS_TRANSITION,
            `Illegal status transition '${from}' -> '${to}'`,
            { methodType, from, to }
        );
    }
}

/**
 * Card payoff: given a card's transactions, return the status-update
 * descriptors for the ones currently on_card. By construction this can
 * only ever describe transitions — it creates no rows and never touches
 * splits or budget accounts.
 *
 * @param {Array<{ id: number, status: string }>} cardTransactions
 * @returns {Array<{ id: number, from: string, to: string }>}
 */
export function payoffTransitions(cardTransactions) {
    return cardTransactions
        .filter((t) => t.status === STATUS.ON_CARD)
        .map((t) => ({ id: t.id, from: STATUS.ON_CARD, to: STATUS.PENDING_MACU }));
}
