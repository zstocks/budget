// Rollover and carryover math — pure, no database access.
//
// Rollover rule: next month's projected = max(base, base + remaining),
// where base is ALWAYS the template's base_amount and remaining is last
// month's projected − actual. The possibly-edited monthly projected feeds
// into remaining (that money really was allocated), but it is never the
// base the carry is added to — otherwise a one-off bump this month would
// permanently inflate every future month. Negative remainders never
// carry: max() resets to base.

export function remaining(projected, actual) {
    return projected - actual;
}

export function rolloverProjected(templateBase, remainingAmount) {
    return Math.max(templateBase, templateBase + remainingAmount);
}

export function carryover(incomeActualAmount, expensesActualAmount) {
    return incomeActualAmount - expensesActualAmount;
}

/**
 * Next month's projected per template, derived from the previous month.
 *
 * @param {Array} templates — account_templates rows (inactive ones skipped)
 * @param {Map<number, { projected: number, id: number }>} prevAccountsByTemplateId
 *        previous month's account instances, keyed by template_id
 * @param {Map<number, number>} prevActuals — account id -> actual (from splits)
 * @returns {Map<number, number>} template id -> next month's projected
 */
export function nextProjections(templates, prevAccountsByTemplateId, prevActuals) {
    const projections = new Map();
    for (const template of templates) {
        if (!template.active) {
            continue;
        }
        const prevAccount = prevAccountsByTemplateId.get(template.id);
        if (!template.rollover || !prevAccount) {
            projections.set(template.id, template.base_amount);
            continue;
        }
        const prevActual = prevActuals.get(prevAccount.id) ?? 0;
        projections.set(
            template.id,
            rolloverProjected(template.base_amount, remaining(prevAccount.projected, prevActual))
        );
    }
    return projections;
}
