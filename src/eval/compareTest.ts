import fs from 'node:fs';
import { evalPaths } from './paths.js';
import os from 'node:os';
import path from 'node:path';
import { runCompare } from './compare.js';
import { loadLedger } from '../spend.js';

// Verifies the regression gate on the real baseline: real run (exit 0 expected), synthetic 6-point drop (exit 1), synthetic 4-point drop (exit 0).
const P = evalPaths();
const base = `${P.results}/baseline-heldout.json`, last = `${P.results}/last-heldout.json`;
const b = JSON.parse(fs.readFileSync(base, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
const lowered = (points: number) => { const c = JSON.parse(JSON.stringify(b)); c.metrics.precision_at_10 = b.metrics.precision_at_10 - points / 100; const f = path.join(tmp, `drop${points}.json`); fs.writeFileSync(f, JSON.stringify(c)); return f; };
const quiet = () => {};
const out = {
  baseline_prompt: b.prompt, baseline_p10: b.metrics.precision_at_10,
  real_exit: runCompare(base, last, quiet),
  synthetic_drop_points: 6, synthetic_drop_exit: runCompare(base, lowered(6), quiet),
  synthetic_small_exit: runCompare(base, lowered(4), quiet),
};
fs.writeFileSync(`${P.results}/compare_test.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${P.results}/spend_summary.json`, JSON.stringify({ phases: loadLedger().phases }, null, 1));
console.log(out);
if (out.synthetic_drop_exit !== 1 || out.synthetic_small_exit !== 0 || out.real_exit !== 0) { console.error('GATE TEST FAILED'); process.exit(1); }
