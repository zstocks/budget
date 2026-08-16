# CLAUDE.md — Cobra Kash (Budget App)

Self-hosted budget app for two users (Zach and Jackie), replacing an Excel workbook. Custom Node HTTP server, zero frameworks, SQLite. Deployed eventually to `budget.zacharystocks.com` on the VPS — but deployment is out of scope for now.

## Current scope: Build Order step 1 ONLY

Schema + pure ledger core. Nothing else.

- SQLite schema (users, payment_methods, months, account_templates, budget_accounts, income entries, transactions, transaction_splits)
- All derivation logic as pure, well-tested modules: split validation, rollover math, credit status machine, on-deck (check-on-deck) tagging, carryover, reconciliation check, per-account remaining
- Tests via Node's built-in test runner (`node --test`) — zero test dependencies

Do NOT build the HTTP server, auth, frontend, wizard UI, or Docker/deploy files in this phase. Those are later layers, built only after this one is verified.

## Working style

- Concept-first: explain the why and surface tradeoffs before writing code; confirm design before implementing.
- Layer-by-layer: build and verify one piece before the next.
- Zach reviews and takes changes into his own repo — prefer clear diffs/edits over sweeping rewrites.

## Stack conventions (non-negotiable)

- ESM modules (`import`/`export`), 4-space indentation, named constants over magic numbers.
- `better-sqlite3` is the ONLY dependency. Synchronous queries. Parameterized statements only — never string interpolation. Column allowlists for any dynamic update.
- Booleans as `0`/`1` integers. Dates as ISO strings. Months as `YYYY-MM` strings.
- Derived values are NEVER stored — always computed from transactions/splits/income rows. (Exception: month close deliberately writes down the next month's carryover and rollover projections as that month's own editable values — see lifecycle.)

## Domain model — critical rules and why

**Core principle: the spreadsheet stored aggregates; the app stores transactions.** Every number the workbook computed by hand (per-account actuals, card balances, Unallocated Income, Disposable Now) is derived from atomic transaction records.

**Transactions & splits.** A transaction: date, description, payment_method_id, total, `logged_by`, `status`, month_id. Splits reference budget accounts and MUST sum exactly to the transaction total — validate server-side (in this phase: in the ledger module). One store run can split across many accounts.

**Credit status machine** (only for transactions on `credit`-type payment methods):
`on_card → pending_macu → cleared`
- `on_card` counts toward that card's live balance.
- Paying off card purchases is a STATUS TRANSITION, never an expense. The money was already counted against budget accounts when the purchase was logged. Payoffs must never touch the budget grid — they affect reconciliation math only. Violating this double-counts spending.
- MACU (checking) transactions are just `cleared` (or `pending_macu` while pending).

**Debt payments are ordinary transactions**, completely separate from the card-payoff lifecycle: paid from MACU, split against a Debt-category budget account (paying down pre-existing balances). Keep these two flows strictly apart.

**Check on Deck.** Paychecks land on days 25, 6, 10, 21. The day-25 check funds the FOLLOWING month. Each income entry has a `budget_month` field. An entry physically received but tagged for a future budget_month is:
- EXCLUDED from the current month's income totals and Unallocated Income
- INCLUDED in bank-side reconciliation (the money physically exists in checking)

**Rollover accounts** (Medical, Merchandise, Grooming, Jackie's Allowance, Zach's Allowance): next month's projected = `max(template_base, template_base + remaining)` where `remaining` = last month's projected − actual. Compute from the TEMPLATE's base, not last month's possibly-edited projected — one-off monthly adjustments must not permanently inflate future months. Negative remainders never carry (reset to base). All non-rollover accounts reset to template base.

**Templates vs. instances.** `account_templates` is the master list (name, category, base amount, rollover flag, sort order, active flag). `budget_accounts` are per-month copies with their own `projected`. After creation they are independent: mid-month edits to a month's projected never touch the template.

## Derived values (pure functions to implement)

For the active month:
- `income_projected` / `income_actual` — sums over income entries, excluding entries tagged for a future `budget_month`
- account `actual` = sum of its transaction splits; `expenses_*` sum over accounts
- `on_deck` = actual of received entries tagged for a future budget_month
- `card_balance(card)` = sum of `on_card` transactions on that card
- `pending_macu` = sum of `pending_macu` transactions
- **Unallocated Income** = income_projected − expenses_projected
- **Disposable Now** = income_actual − expenses_actual + on_deck
- **Bank-side Disposable** = available_in_bank − pending_macu − Σ card_balances (available_in_bank is the one manually entered number)
- **Reconciliation check**: Bank-side Disposable must equal Disposable Now; report the discrepancy amount
- **Per-account Remaining** = projected − actual

## Month lifecycle (implement as testable functions; no UI yet)

Creation and close are separate explicit events; overlap is the NORMAL case (September is created days before August closes).

- **Create:** new month row → instantiate budget accounts from active templates (food-week accounts labeled with date ranges) → income rows from template, adopting any already-recorded next-month-tagged check as the first income row → create `Carryover` and `Other` income rows.
- **While previous month is still open:** the new month's Carryover and rollover projections are LIVE-DERIVED from the open previous month (a late transaction in August updates September's numbers). Everything else is independent immediately.
- **Close:** write the live-derived values down as the next month's own stored, editable values (Carryover = closing month's income_actual − expenses_actual; rollover per the rule). Closed month becomes read-only — ENFORCED in the ledger layer.

## Testing (acceptance gate for this phase)

Node built-in test runner, zero test deps. Must cover: split-sum validation, rollover math (including the edited-projected trap and negative remainders), the status machine (including that payoffs don't hit budget accounts), on-deck exclusion/inclusion, carryover derivation, reconciliation check, and a full simulated two-month lifecycle: create month A → log transactions → create month B early → verify live derivation tracks late month-A changes → close A → verify freeze and read-only enforcement.

Local dev DB path comes from an env var; dev uses throwaway `./data/dev.db`. Include a `seed-dev.js` (templates + a month of plausible fake data). Production seed (later) is structural only: two users, four payment methods (MACU/checking; Jackie's Discover, Zach's Discover, Citi Card/credit), account templates, income template (days 25/6/10/21).

## Anti-patterns — do not do these

- Do not add dependencies (no test libs, no ORMs, no frameworks). `better-sqlite3` only.
- Do not store derived values (outside the deliberate month-close write-down).
- Do not treat a card payoff as an expense or let it touch budget accounts.
- Do not compute rollover from last month's edited projected instead of the template base.
- Do not add a `reconciled` flag — a logged purchase is reconciled by definition.
- Do not build ahead: no HTTP layer, no auth, no frontend, no Docker in this phase.
- Do not use string interpolation in SQL, `===` on secrets (later phases), or CommonJS.
