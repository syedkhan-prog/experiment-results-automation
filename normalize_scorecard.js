const source = $('Prepare Resolved Test').item.json || {};
let payload = $input.first().json || {};
if (Array.isArray(payload.data)) payload = payload.data[0] || {};

const headline = (payload.rows || []).filter((r) => r.treatment_id !== null && r.treatment_id !== undefined);
const cohortRaw = (payload.cohort_rows || []).filter((r) => r.treatment_id !== null && r.treatment_id !== undefined);

const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const rounded = (v, d = 2) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const significance = (value, ci) => {
  const v = n(value);
  const c = n(ci);
  if (v === null || c === null) return 'not_available';
  if (v - c > 0) return 'positive_significant';
  if (v + c < 0) return 'negative_significant';
  return 'not_significant';
};

const meta = Array.isArray(source.treatments) ? source.treatments : [];

const mechanicLabel = (row) => {
  const types = String(row.bonus_type || '').trim().split(/\s+/).filter(Boolean);
  const values = String(row.bonus_value || '').trim().split(/\s+/).filter(Boolean);
  if (!types.length) return null;
  const parts = types.map((type, i) => {
    const value = values[i] !== undefined ? Number(values[i]) : null;
    if (type === 'percentage_of_food_price') return (value === null ? '' : value + '% ') + 'menu discount';
    if (type === 'percentage_of_full_delivery_price') return value === 100 ? 'free delivery' : value + '% off delivery';
    if (type === 'percentage_of_delivery_fee') return value === 100 ? 'free delivery fee' : value + '% off delivery fee';
    if (type === 'fixed_amount') return '€' + value + ' off';
    return type.replace(/_/g, ' ') + (value === null ? '' : ' ' + value);
  });
  parts.sort((a, b) => {
    const rank = (part) => part.includes('menu discount') ? 0 : part.includes('delivery') ? 1 : 2;
    return rank(a) - rank(b);
  });
  const text = parts.join(' + ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const metaFor = (row) => meta.find((x) => Number(x.treatment_id) === Number(row.treatment_id)) || null;
const popularItemsOnly = (m) => {
  const tags = m && m.menu_item_tags;
  if (!tags || tags.mode !== 'include') return false;
  return JSON.stringify(tags.tags || []).toLowerCase().includes('special_offer__portal__popular');
};

const metaLabel = (row) => {
  const m = metaFor(row);
  if (!m) return null;
  if (m.treatment_type === 'targeted_control_campaign') return 'Control';
  const bonus = m.bonus_data || {};
  if (bonus.type === 'percentage_of_food_price' && popularItemsOnly(m)) return 'Popular-item discount';
  if (bonus.type === 'percentage_of_food_price') return 'Full-menu discount';
  if (bonus.type === 'percentage_of_full_delivery_price') return 'Free delivery';
  return null;
};

const scopeFor = (row, mechanic) => {
  const m = metaFor(row);
  if (!m) return mechanic ? mechanic + ' (read from scorecard bonus fields)' : null;
  if (m.treatment_type === 'targeted_control_campaign') return 'No offer';
  const usage = m.max_usages_by_same_user != null ? ', up to ' + m.max_usages_by_same_user + ' uses per eater' : '';
  if (!m.bonus_data) return (mechanic || 'Stacked offer') + ', run as a bundle of campaigns';
  const bonus = m.bonus_data;
  const cap = bonus.max_value != null ? ' capped at \u20ac' + bonus.max_value : '';
  if (bonus.type === 'percentage_of_food_price') {
    return bonus.percentage + '% off ' + (popularItemsOnly(m) ? 'popular items only' : 'the full menu') + cap + usage;
  }
  if (bonus.type === 'percentage_of_full_delivery_price') {
    return (bonus.percentage === 100 ? 'Free delivery' : bonus.percentage + '% off delivery') + cap + usage;
  }
  return (mechanic || String(bonus.type || '').replace(/_/g, ' ')) + cap + usage;
};

const labelFor = (row) => {
  const fromMeta = metaLabel(row);
  if (fromMeta === 'Control') return 'Control';
  const mechanic = mechanicLabel(row);
  const stacked = mechanic && mechanic.includes(' + ');
  if (stacked) return mechanic;
  if (fromMeta) {
    const m = metaFor(row);
    const cap = m && m.bonus_data && m.bonus_data.max_value != null ? ' (up to \u20ac' + m.bonus_data.max_value + ')' : '';
    if (fromMeta === 'Free delivery') return 'Free delivery' + cap;
    const depth = String(row.bonus_value || '').trim().split(/\s+/)[0];
    const suffix = depth && !fromMeta.includes('%') ? ' (' + Number(depth) + '%)' : '';
    return fromMeta + suffix;
  }
  return mechanic || 'Treatment ' + row.treatment_id;
};

const mapRow = (r) => {
  const compliant = n(r.compliant_spend) || 0;
  const violated = n(r.violated_spend) || 0;
  const denom = compliant + violated;
  const uc = n(r.gmv_uc_ratio_bolt);
  const fstat = n(r.gmv_uc_ratio_bolt_fstat);
  return {
    treatment_id: Number(r.treatment_id),
    cohort: r.cohort || null,
    label: labelFor(r),
    mechanic: mechanicLabel(r),
    scope: scopeFor(r, mechanicLabel(r)),
    users_enrolled: n(r.users_enrolled),
    users_enrolled_control: n(r.users_enrolled_control),
    active_eaters: n(r.active_eaters),
    active_eaters_control: n(r.active_eaters_control),
    conversion_rate_pct: rounded(n(r.conversion_rate) * 100),
    conversion_rate_control_pct: rounded(n(r.conversion_rate_control) * 100),
    conversion_uplift_pp: rounded(n(r.conversion_rate_uplift) * 100),
    conversion_uplift_ci_pp: rounded(n(r.conversion_rate_uplift_ci) * 100),
    conversion_significance: significance(r.conversion_rate_uplift, r.conversion_rate_uplift_ci),
    gmv_uplift_eur: rounded(n(r.gmv_uplift), 0),
    gmv_uplift_ci_eur: rounded(n(r.gmv_uplift_ci), 0),
    gmv_significance: significance(r.gmv_uplift, r.gmv_uplift_ci),
    gmv_eur: rounded(n(r.gmv), 0),
    gmv_control_eur: rounded(n(r.gmv_control), 0),
    finished_orders_uplift: rounded(n(r.finished_orders_uplift), 0),
    orders_significance: significance(r.finished_orders_uplift, r.finished_orders_uplift_ci),
    active_eaters_uplift: rounded(n(r.active_eaters_uplift), 0),
    subscriptions_uplift: rounded(n(r.bolt_plus_subscriptions_uplift), 0),
    subscriptions_significance: significance(r.bolt_plus_subscriptions_uplift, r.bolt_plus_subscriptions_uplift_ci),
    bolt_cost_uplift_eur: rounded(n(r.bolt_cost_uplift), 0),
    total_cost_uplift_eur: rounded(n(r.total_cost_uplift), 0),
    gmv_uc_bolt: rounded(uc),
    gmv_uc_bolt_ci: rounded(n(r.gmv_uc_ratio_bolt_ci)),
    gmv_uc_bolt_fstat: rounded(fstat, 1),
    gmv_uc_bolt_valid: uc !== null && fstat !== null && fstat > 10,
    gmv_uc_bolt_efficient: uc !== null && uc > 1,
    gmv_uc_bolt_significance: significance(r.gmv_uc_ratio_bolt, r.gmv_uc_ratio_bolt_ci),
    gmv_uc_total: rounded(n(r.gmv_uc_ratio_total)),
    gmv_uc_total_significance: significance(r.gmv_uc_ratio_total, r.gmv_uc_ratio_total_ci),
    profit_uplift_eur: rounded(n(r.profit_uplift), 0),
    profit_significance: significance(r.profit_uplift, r.profit_uplift_ci),
    profit_uc_bolt: rounded(n(r.profit_uc_ratio_bolt)),
    profit_uc_bolt_fstat: rounded(n(r.profit_uc_ratio_bolt_fstat), 1),
    profit_uc_total: rounded(n(r.profit_uc_ratio_total)),
    contribution_profit_eur: rounded(n(r.contribution_profit), 0),
    contribution_profit_control_eur: rounded(n(r.contribution_profit_control), 0),
    aov_per_user_eur: rounded(n(r.aov_per_user)),
    cost_per_incremental_user_eur: rounded(n(r.cost_per_incremental_user)),
    cost_share_percentage: n(r.cost_share_percentage),
    spend_compliance_pct: denom > 0 ? rounded((compliant / denom) * 100, 1) : null,
    last_ingested: r._last_ingested || null,
  };
};

const scorecardRows = headline.map(mapRow);

const labelCounts = {};
for (const r of scorecardRows) labelCounts[r.label] = (labelCounts[r.label] || 0) + 1;
for (const r of scorecardRows) if (labelCounts[r.label] > 1) r.label = r.label + ' (#' + r.treatment_id + ')';
const hasStackedFreeDelivery = scorecardRows.some((r) => r.label.includes(' + ') && r.label.toLowerCase().includes('free delivery'));
if (hasStackedFreeDelivery) {
  for (const r of scorecardRows) {
    r.label = r.label.replace(/^Free delivery(?! only)/, 'Free delivery only');
  }
}
const labelByTreatment = Object.fromEntries(scorecardRows.map((r) => [r.treatment_id, r.label]));

const cohortScorecardRows = cohortRaw.map((r) => {
  const mapped = mapRow(r);
  mapped.label = labelByTreatment[mapped.treatment_id] || mapped.label;
  return mapped;
});
const ingested = scorecardRows.map((r) => r.last_ingested).filter(Boolean).sort();

return [{
  json: {
    ...source,
    has_data: scorecardRows.length > 0,
    scorecard_rows: scorecardRows,
    cohort_scorecard_rows: cohortScorecardRows,
    scorecard_as_of: ingested.length ? ingested[ingested.length - 1] : null,
    statistical_note: 'Each significance flag compares that treatment with control. The scorecard does not test treatment-versus-treatment differences, so arm rankings are directional.',
  },
}];
