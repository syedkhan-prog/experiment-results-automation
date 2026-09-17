// Local preview: runs the n8n code nodes against live Admin API data so the
// report wording can be reviewed without touching Google Docs.
// Usage: node preview_report.mjs <test_id> [tracker_description]

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TOKEN = process.env.ADMIN_API_TOKEN || 'NLPiHt2ijTw1sXejn311P7l9vCDL63cF';
const BASE = 'http://127.0.0.1:8077';
const testId = process.argv[2] || '6470582';
const description = process.argv[3] || 'AB test : 20% MD + FD vs FD upto 3 EUR  for soft churned';

const get = (path) => JSON.parse(execFileSync('curl', ['-s', '--max-time', '240', '-H', `Authorization: Bearer ${TOKEN}`, `${BASE}${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const link = process.argv[4] || 'https://admin-panel.bolt.eu/campaign-targeting/tests/delivery/' + testId;
const scorecard = get(`/experiment/scorecard?test_id=${testId}`);
const resolved = get(`/experiment/resolve?url=${encodeURIComponent(link)}`);

const source = {
  'Test Description (1 line)': description,
  Market: 'LT',
  Geo: 'Vilnius',
  'Start Date': 'Aug 19, 2026',
  'End Date (Planned)': 'Aug 25, 2026',
  'Experiment Link': link,
  test_id: Number(testId),
  run_date: new Date().toISOString().slice(0, 10),
  report_status: 'FINAL',
  treatments: resolved.treatments || [],
};

const run = (file, input, refs) => {
  const body = readFileSync(new URL(file, import.meta.url), 'utf8');
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
  const $ = (name) => ({ item: { json: refs[name] } });
  return new Function('$input', '$', body)($input, $);
};

const normalized = run('./normalize_scorecard.js', scorecard, { 'Prepare Resolved Test': source })[0].json;
const report = run('./build_report.js', normalized, {})[0].json;

const text = report.requests[0].insertText.text;
console.log(text);
console.log('\n================ ONE-LINER (' + report.one_line_summary.length + ' chars) ================');
console.log(report.one_line_summary);
console.log('\n================ TABLES ================');
for (const t of report.tables) {
  console.log(t.headers.join(' | '));
  for (const r of t.rows) console.log(r.join(' | '));
  console.log('');
}
