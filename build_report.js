const source = $input.first().json || {};
const rows = source.scorecard_rows || [];
if (!rows.length) throw new Error('No scorecard rows');
const cohortRows = source.cohort_scorecard_rows || [];

const desc = String(source['Test Description (1 line)'] || 'Delivery experiment').trim();
const lower = desc.toLowerCase();
let metric = 'conversion';
if (lower.includes('subscription') || lower.includes('bolt plus') || lower.includes('b+')) metric = 'subscriptions';
else if (lower.includes('gmv') || lower.includes('aov')) metric = 'gmv';
const cfg = {
  conversion: { value: 'conversion_uplift_pp', sig: 'conversion_significance', label: 'conversion', unit: 'pp' },
  subscriptions: { value: 'subscriptions_uplift', sig: 'subscriptions_significance', label: 'Bolt Plus subscriptions', unit: '' },
  gmv: { value: 'gmv_uplift_eur', sig: 'gmv_significance', label: 'GMV', unit: 'EUR' },
}[metric];

const int = (v) => (v == null ? 'n/a' : Math.round(Number(v)).toLocaleString('en-US'));
const eur = (v) => (v == null ? 'n/a' : (Number(v) < 0 ? '-' : '') + '€' + Math.abs(Math.round(Number(v))).toLocaleString('en-US'));
const num = (v, d = 2) => (v == null ? 'n/a' : Number(v).toFixed(d));
const pp = (v) => (v == null ? 'n/a' : (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2));
const sigWord = (s) => (s === 'positive_significant' ? 'significant positive' : s === 'negative_significant' ? 'significant negative' : s === 'not_significant' ? 'not significant' : 'not available');
const sigLabel = (s) => (s === 'positive_significant' ? 'Significant +' : s === 'negative_significant' ? 'Significant \u2212' : s === 'not_significant' ? 'Not significant' : 'Not available');
const ucCell = (r) => (r.gmv_uc_bolt == null ? 'n/a' : num(r.gmv_uc_bolt) + (r.gmv_uc_bolt_valid ? '' : ' (low F)'));
const ucStatus = (r) => {
  if (r.gmv_uc_bolt == null) return 'Not available';
  if (!r.gmv_uc_bolt_valid) return 'Not reliable';
  return sigLabel(r.gmv_uc_bolt_significance) + (r.gmv_uc_bolt > 1 ? ', above 1' : ', below 1');
};
const eurK = (v) => {
  if (v == null) return 'n/a';
  const a = Math.abs(Number(v));
  const sign = Number(v) < 0 ? '-' : '';
  return a >= 1000 ? sign + '\u20ac' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : sign + '\u20ac' + Math.round(a);
};
const sigTag = (s) => (s === 'positive_significant' || s === 'negative_significant' ? 'significant' : s === 'not_significant' ? 'not significant' : 'significance not available');
const prettyCohort = (c) => {
  const t = String(c || '').replace(/_(\d+)_/g, ' \u00B7 ').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const primaryValue = (r) => Number(r[cfg.value]);
const primaryPositive = (r) => r[cfg.sig] === 'positive_significant';
const profitNegative = (r) => r.profit_significance === 'negative_significant';
const unit = cfg.unit === 'pp' ? 'pp' : '';
const byPrimary = [...rows].sort((a, b) => (primaryValue(b) || -Infinity) - (primaryValue(a) || -Infinity));
const scaleReady = (r) => primaryPositive(r) && r.gmv_uc_bolt_valid && r.gmv_uc_bolt_efficient && !profitNegative(r);
const eligible = rows.filter(scaleReady);
const blocked = rows.filter((r) => !scaleReady(r));
const toplineBest = [...eligible].sort((a, b) => (primaryValue(b) || -Infinity) - (primaryValue(a) || -Infinity))[0] || null;
const efficiencyBest = [...eligible].sort((a, b) => (b.gmv_uc_bolt ?? -Infinity) - (a.gmv_uc_bolt ?? -Infinity))[0] || null;
const splitCall = toplineBest && efficiencyBest && toplineBest.treatment_id !== efficiencyBest.treatment_id;
const controlUsers = rows[0] ? rows[0].users_enrolled_control : null;

const ratio = (v) => (v == null ? 'n/a' : (Number(v) < 0 ? '-\u20ac' : '\u20ac') + num(Math.abs(Number(v))));
const disqualifiedNote = (r) => {
  const reasons = [];
  if (!primaryPositive(r)) reasons.push('no significant ' + cfg.label + ' gain vs control');
  if (profitNegative(r)) reasons.push('contribution profit significantly negative (' + eur(r.profit_uplift_eur) + ')');
  if (!r.gmv_uc_bolt_valid) reasons.push('U/C not statistically usable (F=' + num(r.gmv_uc_bolt_fstat, 1) + ')');
  else if (!r.gmv_uc_bolt_efficient) reasons.push('returns less than \u20ac1 of GMV per \u20ac1 of Bolt cost (U/C ' + num(r.gmv_uc_bolt) + ')');
  return reasons.join('; ');
};
const shortBlock = (r) => {
  if (profitNegative(r)) return 'lost money (contribution profit ' + eurK(r.profit_uplift_eur) + ', significant)';
  if (!primaryPositive(r)) return 'no significant ' + cfg.label + ' gain';
  if (!r.gmv_uc_bolt_valid) return 'U/C not reliable';
  if (!r.gmv_uc_bolt_efficient) return 'GMV U/C below 1';
  return 'weaker';
};
const armWorked = (r) => r.label + ' lifted ' + cfg.label + ' ' + pp(primaryValue(r)) + unit + ' and GMV ' + eur(r.gmv_uplift_eur)
  + ' against control, on ' + eur(r.bolt_cost_uplift_eur) + ' of Bolt cost (' + ratio(r.gmv_uc_bolt) + ' of GMV per \u20ac1 spent), with contribution profit '
  + eur(r.profit_uplift_eur) + ' (' + sigWord(r.profit_significance) + ')';

const prefix = source.report_status === 'INTERIM' ? 'Interim read. ' : '';
const blockedSentence = blocked.length
  ? 'Do not scale ' + blocked.map((r) => r.label + ': ' + (disqualifiedNote(r) || 'did not clear the criteria')).join('. Do not scale ') + '. '
  : '';
const decisionRule = 'Decision rule: scale an arm only if it beats control significantly on the primary metric, returns more than \u20ac1 of GMV per \u20ac1 of Bolt cost on a usable U/C, and is not significantly profit-negative.';

let conclusion;
let oneLine;
let recommendation;

const conclusionParts = controlUsers ? ['All arms are measured against the same control group of ' + int(controlUsers) + ' users.'] : [];
if (eligible.length) conclusionParts.push('What worked: ' + eligible.map(armWorked).join('. ') + '.');
if (blocked.length) conclusionParts.push('What did not work: ' + blocked.map((r) => r.label + ', ' + (disqualifiedNote(r) || 'did not clear the scale criteria')).join('; ') + '.');

if (splitCall) {
  const extraPrimary = (primaryValue(toplineBest) || 0) - (primaryValue(efficiencyBest) || 0);
  const extraGmv = (toplineBest.gmv_uplift_eur || 0) - (efficiencyBest.gmv_uplift_eur || 0);
  const extraCost = (toplineBest.bolt_cost_uplift_eur || 0) - (efficiencyBest.bolt_cost_uplift_eur || 0);
  const marginalUc = extraCost > 0 ? extraGmv / extraCost : null;
  const cpBetter = (toplineBest.profit_uplift_eur ?? -Infinity) >= (efficiencyBest.profit_uplift_eur ?? -Infinity) ? toplineBest : efficiencyBest;
  const cpOther = cpBetter === toplineBest ? efficiencyBest : toplineBest;

  conclusionParts.push('Both arms are safe to run and they answer different questions: ' + toplineBest.label + ' buys more volume, ' + efficiencyBest.label + ' buys volume more cheaply.');
  conclusion = conclusionParts.join(' ');

  oneLine = prefix + 'Both arms beat control. ' + toplineBest.label + ' for topline (GMV ' + eurK(toplineBest.gmv_uplift_eur)
    + ', contribution profit ' + eurK(toplineBest.profit_uplift_eur) + ' ' + sigTag(toplineBest.profit_significance) + '); '
    + efficiencyBest.label + ' for spend efficiency (' + ratio(efficiencyBest.gmv_uc_bolt) + ' of GMV per \u20ac1 spent vs '
    + ratio(toplineBest.gmv_uc_bolt) + '). Pick by objective.';

  recommendation = 'Both arms clear the bar, so choose by objective. '
    + 'To grow GMV, scale ' + toplineBest.label + ': it added ' + eur(toplineBest.gmv_uplift_eur) + ' of incremental GMV, '
    + eur(extraGmv) + ' more than ' + efficiencyBest.label + ', for ' + eur(extraCost) + ' more Bolt cost'
    + (marginalUc ? ', so every extra \u20ac1 of Bolt spend brought back about ' + ratio(marginalUc) + ' of extra GMV' : '')
    + ', and it also led on ' + cfg.label + ' (' + pp(primaryValue(toplineBest)) + unit + ' vs ' + pp(primaryValue(efficiencyBest)) + unit
    + ', a gap of ' + pp(extraPrimary) + unit + '). '
    + 'To spend less for the same kind of win, use ' + efficiencyBest.label + ': it also beat control significantly on ' + cfg.label
    + ' (' + pp(primaryValue(efficiencyBest)) + unit + ') while spending ' + eur(efficiencyBest.bolt_cost_uplift_eur) + ' of Bolt cost against '
    + eur(toplineBest.bolt_cost_uplift_eur) + ', the best GMV per euro in the test (' + ratio(efficiencyBest.gmv_uc_bolt) + ' vs ' + ratio(toplineBest.gmv_uc_bolt) + '). '
    + 'Contribution profit points to ' + cpBetter.label + ' (' + eur(cpBetter.profit_uplift_eur) + ', ' + sigWord(cpBetter.profit_significance) + ') over '
    + cpOther.label + ' (' + eur(cpOther.profit_uplift_eur) + ', ' + sigWord(cpOther.profit_significance) + '), so the heavier spend is not loss-making. '
    + blockedSentence + decisionRule;
} else if (toplineBest) {
  conclusionParts.push(toplineBest.label + ' leads on both volume and spend efficiency, so there is no trade-off to resolve.');
  conclusion = conclusionParts.join(' ');

  const loser = blocked.length ? [...blocked].sort((a, b) => (primaryValue(b) || -Infinity) - (primaryValue(a) || -Infinity))[0] : null;
  const cpPhrase = toplineBest.profit_significance === 'positive_significant'
    ? 'contribution profit ' + eurK(toplineBest.profit_uplift_eur) + ' (significant)'
    : 'contribution profit flat (' + eurK(toplineBest.profit_uplift_eur) + ', not significant)';
  oneLine = prefix + toplineBest.label + ' is the arm to scale: GMV ' + eurK(toplineBest.gmv_uplift_eur) + ' and ' + cfg.label + ' '
    + pp(primaryValue(toplineBest)) + unit + ' vs control, ' + cpPhrase
    + (loser ? '. ' + loser.label + ' ' + shortBlock(loser) + '.' : '.');

  recommendation = 'Scale ' + toplineBest.label + ': ' + cfg.label + ' ' + pp(primaryValue(toplineBest)) + unit + ' vs control, GMV '
    + eur(toplineBest.gmv_uplift_eur) + ' on ' + eur(toplineBest.bolt_cost_uplift_eur) + ' of Bolt cost (' + ratio(toplineBest.gmv_uc_bolt)
    + ' of GMV per \u20ac1 spent, F=' + num(toplineBest.gmv_uc_bolt_fstat, 1) + '), contribution profit ' + eur(toplineBest.profit_uplift_eur)
    + ' (' + sigWord(toplineBest.profit_significance) + '). ' + blockedSentence + decisionRule;
} else {
  const best = byPrimary[0];
  conclusionParts.push('No arm clears the bar to scale on this read.' + (best ? ' ' + best.label + ' was directionally highest on ' + cfg.label + ' at ' + pp(primaryValue(best)) + unit + ', but not on evidence strong enough to act on.' : ''));
  conclusion = conclusionParts.join(' ');
  oneLine = prefix + 'No arm qualifies to scale: ' + rows.map((r) => r.label + ' ' + shortBlock(r)).join('; ') + '.';
  recommendation = 'Do not make a scale decision from this read. Either run to the planned end date, or redesign and re-power the test before retesting. ' + decisionRule;
}
oneLine = oneLine.replace(/\u2014/g, ',').slice(0, 300);

const MIN_SAMPLE = 300;
const cohortNames = [...new Set(cohortRows.map((r) => r.cohort))];
const keptCohorts = cohortNames.filter((c) => cohortRows.some((r) => r.cohort === c && (r.users_enrolled || 0) >= MIN_SAMPLE));
const cohortTableRows = [];
for (const c of keptCohorts) {
  for (const r of cohortRows.filter((x) => x.cohort === c)) {
    cohortTableRows.push([
      prettyCohort(c),
      r.label,
      int(r.users_enrolled),
      pp(r.conversion_uplift_pp),
      sigLabel(r.conversion_significance),
      eur(r.gmv_uplift_eur),
      sigLabel(r.gmv_significance),
      ucCell(r),
      num(r.profit_uc_bolt),
    ]);
  }
}

let cohortNarrative = '';
if (keptCohorts.length) {
  const agg = keptCohorts.map((c) => {
    const list = cohortRows.filter((r) => r.cohort === c && r.gmv_uplift_eur != null);
    const gmv = list.reduce((s, r) => s + (r.gmv_uplift_eur || 0), 0);
    const cost = list.reduce((s, r) => s + (r.bolt_cost_uplift_eur || 0), 0);
    const best = [...list].sort((a, b) => (b.gmv_uplift_eur || -Infinity) - (a.gmv_uplift_eur || -Infinity))[0] || null;
    return { cohort: c, gmv, cost, uc: cost > 0 ? gmv / cost : null, best, list };
  }).filter((a) => a.list.length);

  const lines = [];
  if (agg.length) {
    const ranked = [...agg].sort((a, b) => b.gmv - a.gmv);
    const top = ranked[0];
    const bottom = ranked[ranked.length - 1];
    lines.push('Most incremental GMV came from ' + prettyCohort(top.cohort) + ' (' + eur(top.gmv) + ' across arms, ' + ratio(top.uc) + ' of GMV per \u20ac1 spent).');
    if (bottom !== top) lines.push('Least came from ' + prettyCohort(bottom.cohort) + ' (' + eur(bottom.gmv) + ', ' + ratio(bottom.uc) + ' per \u20ac1 spent).');

    const wins = {};
    for (const a of agg) if (a.best) wins[a.best.label] = (wins[a.best.label] || 0) + 1;
    const ordered = Object.entries(wins).sort((a, b) => b[1] - a[1]);
    if (ordered.length === 1) lines.push(ordered[0][0] + ' delivered the higher GMV uplift in all ' + agg.length + ' readable cohorts.');
    else if (ordered.length > 1) {
      const [leadLabel, leadCount] = ordered[0];
      const exceptions = agg.filter((a) => a.best && a.best.label !== leadLabel).map((a) => prettyCohort(a.cohort) + ' (' + a.best.label + ', ' + ratio(a.best.gmv_uc_bolt) + ' per \u20ac1)');
      lines.push(leadLabel + ' delivered the higher GMV uplift in ' + leadCount + ' of ' + agg.length + ' readable cohorts; the exception' + (exceptions.length > 1 ? 's were ' : ' was ') + exceptions.join(', ') + '.');
    }

    const armCount = new Set(cohortRows.map((r) => r.label)).size;
    const groupText = (list) => {
      const byCohort = {};
      for (const r of list) (byCohort[r.cohort] = byCohort[r.cohort] || []).push(r.label);
      return Object.entries(byCohort)
        .map(([c, labels]) => prettyCohort(c) + ' (' + (labels.length >= armCount ? (armCount === 2 ? 'both arms' : 'all arms') : labels.join(', ')) + ')')
        .join(', ');
    };
    const readable = cohortRows.filter((r) => keptCohorts.includes(r.cohort));
    const convMiss = readable.filter((r) => r.conversion_significance !== 'positive_significant');
    if (convMiss.length) lines.push('Conversion did not beat control significantly in ' + groupText(convMiss) + '.');

    const withCp = readable.filter((r) => r.profit_uc_bolt != null);
    const cpPositive = withCp.filter((r) => r.profit_uc_bolt > 0);
    if (withCp.length && cpPositive.length === withCp.length) {
      lines.push('Contribution profit per \u20ac1 spent stayed positive in every readable cohort.');
    } else if (withCp.length && cpPositive.length && cpPositive.length <= withCp.length / 2) {
      lines.push('Contribution profit per \u20ac1 spent was positive only in ' + groupText(cpPositive) + '; every other cohort and arm was profit-negative per euro spent.');
    } else if (withCp.length && cpPositive.length) {
      lines.push('Contribution profit per \u20ac1 spent turned negative in ' + groupText(withCp.filter((r) => r.profit_uc_bolt <= 0)) + '.');
    } else if (withCp.length) {
      lines.push('No readable cohort was profit-positive per euro spent.');
    }
  }
  cohortNarrative = lines.join(' ');
}

let text = '';
const titleRanges = [];
const statusRanges = [];
const sectionRanges = [];
const noteRanges = [];
const tables = [];
const add = (v) => { text += v; };
const marked = (v, bucket) => { const start = text.length + 1; text += v; bucket.push({ startIndex: start, endIndex: text.length + 1 }); };
const section = (name) => marked(name + '\n', sectionRanges);
const tableAnchor = (headers, dataRows) => {
  const index = text.length + 1;
  text += '\n';
  tables.push({ index, headers, rows: dataRows });
};

const reportTitle = (source.report_status === 'INTERIM' ? 'Interim result: ' : 'Experiment result: ') + desc.slice(0, 90);
marked(reportTitle + '\n', titleRanges);
marked(source.report_status + ' \u00B7 As of ' + source.run_date + '\n', statusRanges);
add('Data last ingested: ' + (source.scorecard_as_of || 'not available') + '\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n');

section('Executive conclusion');
add(conclusion + '\n\nOne-line summary: ' + oneLine + '\n\n');

section('Test objective');
add(desc + '\n\n');

section('Test setup');
add('\u2022 Market: ' + String(source.Market || '') + '\n\u2022 Geography: ' + String(source.Geo || '') + '\n\u2022 Start date: ' + String(source['Start Date'] || '') + '\n\u2022 Planned end date: ' + String(source['End Date (Planned)'] || '') + '\n\u2022 Delivery test ID: ' + source.test_id + '\n\u2022 Control: ' + (controlUsers ? int(controlUsers) + ' users, no offer' : 'see experiment link') + '\n\u2022 Arms, as configured in the bulk group:\n');
for (const r of rows) {
  add('   \u2013 ' + r.label + ' (' + r.treatment_id + '): ' + (r.scope || r.mechanic || 'setup not available')
    + (r.cost_share_percentage != null ? ', merchant cost share ' + num(r.cost_share_percentage, 0) + '%' : '') + '\n');
}
add('\u2022 Experiment link: ' + String(source['Experiment Link'] || '') + '\n\n');

section('Results by arm');
tableAnchor(
  ['Treatment arm', 'Users', 'Conversion: arm vs control', '\u0394 pp', 'Conv. significance', 'GMV uplift vs control', 'GMV significance', 'Orders uplift'],
  rows.map((r) => [
    r.label,
    int(r.users_enrolled),
    num(r.conversion_rate_pct) + '% vs ' + num(r.conversion_rate_control_pct) + '%',
    pp(r.conversion_uplift_pp),
    sigLabel(r.conversion_significance),
    eur(r.gmv_uplift_eur),
    sigLabel(r.gmv_significance),
    pp(r.finished_orders_uplift).replace('.00', '') + ' (' + sigLabel(r.orders_significance) + ')',
  ]),
);
add('\n');
section('Economics by arm');
tableAnchor(
  ['Treatment arm', 'Total cost', 'Bolt cost', 'GMV U/C', 'U/C significance', 'CP uplift', 'CP significance', 'CP U/C', 'Cost / incr. eater'],
  rows.map((r) => [
    r.label,
    eur(r.total_cost_uplift_eur),
    eur(r.bolt_cost_uplift_eur),
    ucCell(r),
    ucStatus(r),
    eur(r.profit_uplift_eur),
    sigLabel(r.profit_significance),
    num(r.profit_uc_bolt),
    eur(r.cost_per_incremental_user_eur),
  ]),
);
marked('GMV U/C = incremental GMV per \u20ac1 of Bolt cost. CP U/C = incremental contribution profit per \u20ac1 of Bolt cost.\n\n', noteRanges);

if (cohortTableRows.length) {
  section('Cohort performance');
  add(cohortNarrative + '\n\n');
  tableAnchor(['Cohort', 'Treatment arm', 'Users', '\u0394 pp', 'Conv. significance', 'GMV uplift', 'GMV significance', 'GMV U/C', 'CP U/C'], cohortTableRows);
  add('\n');
}

section('Recommendation');
add(recommendation + '\n\n');

const BOLT_GREEN = { red: 0.204, green: 0.733, blue: 0.471 };
const BOLT_DARK = { red: 0.08, green: 0.28, blue: 0.2 };
const requests = [
  { insertText: { location: { index: 1 }, text } },
  { updateDocumentStyle: { documentStyle: { pageSize: { width: { magnitude: 842, unit: 'PT' }, height: { magnitude: 595, unit: 'PT' } }, marginTop: { magnitude: 36, unit: 'PT' }, marginBottom: { magnitude: 36, unit: 'PT' }, marginLeft: { magnitude: 36, unit: 'PT' }, marginRight: { magnitude: 36, unit: 'PT' } }, fields: 'pageSize,marginTop,marginBottom,marginLeft,marginRight' } },
  { updateTextStyle: { range: { startIndex: 1, endIndex: text.length + 1 }, textStyle: { weightedFontFamily: { fontFamily: 'Inter' }, fontSize: { magnitude: 10, unit: 'PT' }, foregroundColor: { color: { rgbColor: { red: 0.09, green: 0.17, blue: 0.14 } } } }, fields: 'weightedFontFamily,fontSize,foregroundColor' } },
  { updateParagraphStyle: { range: { startIndex: 1, endIndex: text.length + 1 }, paragraphStyle: { lineSpacing: 115, spaceBelow: { magnitude: 4, unit: 'PT' } }, fields: 'lineSpacing,spaceBelow' } },
];
for (const r of titleRanges) requests.push({ updateTextStyle: { range: r, textStyle: { bold: true, fontSize: { magnitude: 18, unit: 'PT' }, foregroundColor: { color: { rgbColor: BOLT_GREEN } } }, fields: 'bold,fontSize,foregroundColor' } });
for (const r of statusRanges) requests.push({ updateTextStyle: { range: r, textStyle: { bold: true, fontSize: { magnitude: 10, unit: 'PT' }, foregroundColor: { color: { rgbColor: source.report_status === 'INTERIM' ? { red: 0.82, green: 0.49, blue: 0.08 } : BOLT_GREEN } } }, fields: 'bold,fontSize,foregroundColor' } });
for (const r of sectionRanges) requests.push({ updateTextStyle: { range: r, textStyle: { bold: true, fontSize: { magnitude: 12, unit: 'PT' }, foregroundColor: { color: { rgbColor: BOLT_DARK } } }, fields: 'bold,fontSize,foregroundColor' } });
for (const r of noteRanges) requests.push({ updateTextStyle: { range: r, textStyle: { italic: true, fontSize: { magnitude: 8, unit: 'PT' }, foregroundColor: { color: { rgbColor: { red: 0.42, green: 0.46, blue: 0.44 } } } }, fields: 'italic,fontSize,foregroundColor' } });
for (const t of [...tables].sort((a, b) => b.index - a.index)) {
  requests.push({ insertTable: { rows: t.rows.length + 1, columns: t.headers.length, location: { index: t.index } } });
}

return [{
  json: {
    ...source,
    report_title: reportTitle,
    one_line_summary: oneLine,
    requests,
    tables: tables.map((t) => ({ headers: t.headers, rows: t.rows })),
  },
}];
