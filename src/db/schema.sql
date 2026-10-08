-- Cobra Kash — SQLite schema
--
-- Conventions (see CLAUDE.md):
--   * All money amounts are INTEGER cents. Never REAL dollars.
--   * Booleans are 0/1 integers.
--   * Dates are ISO strings ('YYYY-MM-DD' or full timestamps); months are 'YYYY-MM'.
--   * Derived values are never stored. Exception: month close deliberately writes
--     the next month's carryover and rollover projections down as that month's
--     own editable values.
--   * Invariants SQL cannot express declaratively are enforced in the ledger
--     modules: splits sum exactly to their transaction's total; every split's
--     account belongs to the transaction's month; 'on_card' status only on
--     credit-type payment methods; status transitions only move forward;
--     closed months reject all writes; income actual/received_date are set
--     together or not at all.

CREATE TABLE IF NOT EXISTS users (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS payment_methods (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    type          TEXT NOT NULL CHECK (type IN ('checking', 'credit')),
    owner_user_id INTEGER REFERENCES users(id),        -- NULL for shared (MACU)
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS months (
    id                INTEGER PRIMARY KEY,
    month             TEXT NOT NULL UNIQUE
                          CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    available_in_bank INTEGER,             -- cents; the ONE manually entered number
    created_at        TEXT NOT NULL,       -- ISO
    closed_at         TEXT                 -- ISO, set on close
);

-- Master account list. budget_accounts are per-month instances; after
-- instantiation a month's projected is independent of the template, but
-- rollover math always reads base_amount from HERE, never from a month's
-- possibly-edited projected.
CREATE TABLE IF NOT EXISTS account_templates (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    category    TEXT NOT NULL,
    base_amount INTEGER NOT NULL,          -- cents
    rollover    INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0, 1)),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS budget_accounts (
    id          INTEGER PRIMARY KEY,
    month_id    INTEGER NOT NULL REFERENCES months(id),
    template_id INTEGER REFERENCES account_templates(id),  -- NULL = ad-hoc, this month only
    name        TEXT NOT NULL,             -- snapshot; food weeks get date-range labels
    category    TEXT NOT NULL,             -- snapshot, for display stability
    projected   INTEGER NOT NULL,          -- cents; independently editable after creation
    sort_order  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (month_id, name)
);

-- Paycheck schedule (days 25/6/10/21). funds_next_month marks the day-25
-- check, whose income entry is tagged for the FOLLOWING budget month.
CREATE TABLE IF NOT EXISTS income_templates (
    id               INTEGER PRIMARY KEY,
    label            TEXT NOT NULL,
    day_of_month     INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    funds_next_month INTEGER NOT NULL DEFAULT 0 CHECK (funds_next_month IN (0, 1)),
    amount           INTEGER NOT NULL,     -- cents, projected per check
    sort_order       INTEGER NOT NULL DEFAULT 0,
    active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- budget_month is deliberately a 'YYYY-MM' string, NOT an FK to months:
-- the day-25 check is recorded before its target month row may exist.
-- A month's income list is simply WHERE budget_month = that month, so
-- future-tagged checks are structurally excluded from the current month's
-- totals, and on-deck = received entries with budget_month > active month.
CREATE TABLE IF NOT EXISTS income_entries (
    id            INTEGER PRIMARY KEY,
    budget_month  TEXT NOT NULL            -- month this money FUNDS
                      CHECK (budget_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    kind          TEXT NOT NULL DEFAULT 'check'
                      CHECK (kind IN ('check', 'carryover', 'other')),
    label         TEXT NOT NULL,
    projected     INTEGER NOT NULL DEFAULT 0,  -- cents
    actual        INTEGER,                 -- cents; NULL = not yet received
    received_date TEXT,                    -- ISO; set together with actual
    sort_order    INTEGER NOT NULL DEFAULT 0
);

-- Status machine (credit-type methods only): on_card -> pending_macu -> cleared.
-- Card payoffs are bulk status transitions on these rows — never new rows,
-- never expenses. MACU transactions are 'cleared' (or 'pending_macu' while
-- pending) and never 'on_card'.
CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY,
    month_id          INTEGER NOT NULL REFERENCES months(id),  -- budget month, user-chosen
    date              TEXT NOT NULL,       -- ISO calendar date
    description       TEXT NOT NULL,
    payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id),
    total             INTEGER NOT NULL,    -- cents; negative allowed (refunds)
    status            TEXT NOT NULL CHECK (status IN ('on_card', 'pending_macu', 'cleared')),
    logged_by         INTEGER NOT NULL REFERENCES users(id),
    created_at        TEXT NOT NULL        -- ISO
);

CREATE TABLE IF NOT EXISTS transaction_splits (
    id                INTEGER PRIMARY KEY,
    transaction_id    INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    budget_account_id INTEGER NOT NULL REFERENCES budget_accounts(id),
    amount            INTEGER NOT NULL,    -- cents
    UNIQUE (transaction_id, budget_account_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_month         ON transactions(month_id);
CREATE INDEX IF NOT EXISTS idx_transactions_method_status ON transactions(payment_method_id, status);
CREATE INDEX IF NOT EXISTS idx_splits_transaction         ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_splits_account             ON transaction_splits(budget_account_id);
CREATE INDEX IF NOT EXISTS idx_budget_accounts_month      ON budget_accounts(month_id);
CREATE INDEX IF NOT EXISTS idx_income_budget_month        ON income_entries(budget_month);
