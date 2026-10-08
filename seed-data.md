# Seed Data — Cobra Kash

Structural seed for the production database, extracted from the October 2026 workbook. Amounts are dollars here for readability; if the integer-cents convention is adopted, `seed-dev.js` / the production seed converts on insert (e.g. `249.99` → `24999`).

**Review status: DRAFT — Zach to verify amounts before handing off.** Items marked ⚠ need a decision. For rollover accounts, the base below was derived as `projected − carryover` from the workbook snapshot.

## Users

| Username |
|---|
| Zach |
| Jackie |

## Payment Methods

| Name | Type |
|---|---|
| MACU | checking |
| Jackie's Discover | credit |
| Zach's Discover | credit |
| Citi Card | credit |

## Account Templates

Sort order = row order below. Rollover accounts per design: Medical, Merchandise, Grooming, Jackie's Allowance, Zach's Allowance.

### Savings

| Account | Base | Rollover | Notes |
|---|---|---|---|
| Savings | 1000.00 | 0 | |

### Debt

| Account | Base | Rollover | Notes |
|---|---|---|---|
| Jackie's Discover Card | 250.00 | 0 | |
| Zach's Discover Card | 200.00 | 0 | |
| Citi Card | 550.00 | 0 | |
| MACU Loan | 275.00 | 0 | |
| Zach's Student Loan | 230.34 | 0 | |
| Jackie's Student Loan | 399.02 | 0 | |

### Bills

| Account | Base | Rollover | Notes |
|---|---|---|---|
| Rent | 1893.00 | 0 | |
| Car Insurance | 109.53 | 0 | |
| Gas | 50.00 | 0 | |
| Electric | 75.00 | 0 | |
| Conservice | 115.00 | 0 | |
| Phone | 300.00 | 0 | |

### Expenses

| Account | Base | Rollover | Notes |
|---|---|---|---|
| Medical | 250.00 | 1 | |
| Car Maintenance | 42.99 | 0 | Specific amount for our monthly car wash membership |
| Gasoline | 100.00 | 0 | |
| Cats | 150.00 | 0 | |
| Groceries | 150.00 | 0 | |
| Food W1 (Zach) | 225.00 | 0 | |
| Food W1 (Jackie) | 225.00 | 0 | |
| Food W2 (Zach) | 225.00 | 0 | |
| Food W2 (Jackie) | 225.00 | 0 | |
| Food W3 (Zach) | 225.00 | 0 | |
| Food W3 (Jackie) | 225.00 | 0 | |
| Food W4 (Zach) | 250.00 | 0 | Higher base — W4 covers 22 through month-end (longer week) |
| Food W4 (Jackie) | 250.00 | 0 | |
| Merchandise | 150.00 | 1 | |
| Grooming | 250.00 | 1 | |
| Travel | 0.00 | 0 | Zero-base placeholder, funded ad hoc |
| Gifts | 0.00 | 0 | Zero-base placeholder |
| Software | 250.00 | 0 | |
| Other Expenses | 100.00 | 0 | |

Food-week note: the wizard generates these per person per week and labels each with the month's actual date ranges (e.g. "Food W1 | 1–7 (Zach)"). The template stores the base per person per week; date-range labels are per-month, not part of the template name.

### Leisure

| Account | Base | Rollover | Notes |
|---|---|---|---|
| Jackie's Allowance | 250.00 | 1 | |
| Zach's Allowance | 250.00 | 1 | |
| Spotify | 20.38 | 0 | |
| YouTube | 34.99 | 0 | |
| Netflix | 28.96 | 0 | |
| Coursera | 52.58 | 0 | |
| Pimsleur | 22.52 | 0 | |
| HBO | 19.79 | 0 | |
| Adobe | 75.10 | 0 | |
| Amazon Prime | 21.43 | 0 | |
| Apple TV | 13.94 | 0 | |
| Movies | 150.00 | 0 | |
| Other Leisure | 150.00 | 0 | |

## Income Template

Fixed paycheck days. The day-25 entry is always tagged `budget_month = following month` (Check on Deck).

| Day | Typical Amount | Notes |
|---|---|---|
| 25 | 3201.95 | Funds the FOLLOWING month's budget |
| 6 | 1500.00 | |
| 10 | 3201.95 | |
| 21 | 1500.00 | |

The wizard additionally creates per-month `Carryover` and `Other` income rows; these are lifecycle rows, not template entries (Carryover is derived at month close, Other defaults to 0).

## First-Month Bootstrap (November 2026)

Hand-entered once, since no prior month exists in the database:

- **Carryover**: from the closing October workbook (`income_actual − expenses_actual`) — value TBD at cutover.
- **Rollover projected** for Medical, Merchandise, Grooming, Jackie's Allowance, Zach's Allowance: set directly from the October workbook's remaining amounts (`base + remaining`, floored at base).
- The check landing **October 25** is entered in the app when it arrives, tagged `budget_month = 2026-11`; the November wizard adopts it as the first income row.
