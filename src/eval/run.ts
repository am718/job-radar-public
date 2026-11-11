import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { budgetedLlm, summary, loadLedger, BudgetError } from '../spend.js';
import { estimateCost, printEstimate } from '../cost.js';
import { splitOf } from './metrics.js';
import { loadGold, requireApproval, jobsByKey } from './common.js';
import { runEval, knownPrompt } from './lib.js';
import { evalPaths, dirProfileSummary } from './paths.js';
import { fakeScorerLlm } from './fakeLlm.js';

// usage: npm run eval -- --prompt v3 --split dev|heldout|all [--k 3] [--save-baseline] [--sample] [--fake-llm]
// Data dir: EVAL_DIR, else --sample (eval/sample), else eval/private if present, else eval/sample (see paths.ts).
// Writes <dir>/results/<prompt>-<split>-<ts>.json and <dir>/results/last-<split>.json. Charges phase B ledger (cap $15).
// --fake-llm: deterministic offline scorer (no API key, no ledger); for demonstrating the harness only.
const a = process.argv.slice(2);
const opt = (n: string, d: string) => (a.includes(`--${n}`) ? a[a.indexOf(`--${n}`) + 1] : d);
const fake = a.includes('--fake-llm');
const P = evalPaths();
const pv = opt('prompt', 'v3'), split = opt('split', 'dev') as 'dev' | 'heldout' | 'all', k = Number(opt('k', '3'));
knownPrompt(pv); requireApproval(P);

const gold = loadGold(P);
const jobs = jobsByKey(gold.map((g) => g.key), P);
const sel = gold.filter((g) => split === 'all' || splitOf(g.key) === split);
console.log(`eval data dir: ${P.dir}${fake ? ' (fake LLM)' : ''}`);
if (!fake) {
  const est = estimateCost(sel.map((g) => jobs.get(g.key).description.length), k);
  printEstimate(`eval ${pv}/${split}, n=${sel.length}`, est);
  if (est.usd != null && loadLedger().phases.B.spent_usd + est.usd > loadLedger().phases.B.cap_usd) { console.error('estimate would pass the phase B cap; aborting'); console.error(summary('B')); process.exit(3); }
}

let res;
try { res = await runEval({ gold, jobs, llm: fake ? fakeScorerLlm : budgetedLlm('B', `eval ${pv}/${split}`), pv, split, k, profileSummary: dirProfileSummary(P) }); }
catch (e) { if (e instanceof BudgetError) { console.error(e.message); process.exit(3); } throw e; }
fs.mkdirSync(P.results, { recursive: true });
fs.writeFileSync(path.join(P.results, `${pv}-${split}-${res.timestamp.replace(/[:.]/g, '-')}.json`), JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(P.results, `last-${split}.json`), JSON.stringify(res, null, 1));
if (a.includes('--save-baseline')) fs.writeFileSync(path.join(P.results, `baseline-${split}.json`), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ prompt: pv, split, split_counts: res.split_counts, dropped: res.dropped_jobs_due_to_invalid_output, failures: res.failures.length, metrics: res.metrics }, null, 1));
if (!fake) console.log(summary('B'));
