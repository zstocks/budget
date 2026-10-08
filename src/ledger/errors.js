// Shared error type for ledger invariant violations.
//
// Validators THROW rather than returning result objects: at this layer a
// failed invariant means the write must not happen, and throwing composes
// with better-sqlite3's transaction wrapper (throw -> rollback) once the
// DB layer is added. Codes are stable constants — tests and callers match
// on err.code, never on message text.

export const ERROR_CODES = Object.freeze({
    SPLIT_EMPTY: 'SPLIT_EMPTY',
    SPLIT_NON_INTEGER_AMOUNT: 'SPLIT_NON_INTEGER_AMOUNT',
    SPLIT_ZERO_AMOUNT: 'SPLIT_ZERO_AMOUNT',
    SPLIT_DUPLICATE_ACCOUNT: 'SPLIT_DUPLICATE_ACCOUNT',
    SPLIT_UNKNOWN_ACCOUNT: 'SPLIT_UNKNOWN_ACCOUNT',
    SPLIT_WRONG_MONTH: 'SPLIT_WRONG_MONTH',
    SPLIT_SUM_MISMATCH: 'SPLIT_SUM_MISMATCH',
    UNKNOWN_METHOD_TYPE: 'UNKNOWN_METHOD_TYPE',
    INVALID_STATUS: 'INVALID_STATUS',
    INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
});

export class LedgerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'LedgerError';
        this.code = code;
        this.details = details;
    }
}
