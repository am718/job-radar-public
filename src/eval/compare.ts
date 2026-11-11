import fs from 'node:fs';
import { evalPaths } from './paths.js';
import { compareToBaseline } from './metrics.js';

/** Returns process exit code: 0 ok, 1 regression (precision@10 dropped > 5 points), 2 bad input. */
export function runCompare(baselinePath: string, lastPath: string, log: (s: string) => void = console.log): number {
  if (!fs.existsSync(baselinePath) || !fs.existsSync(lastPath)) { log(`need ${baselinePath} and ${lastPath} (run npm run eval first)`); return 2; }
  const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8')), c = JSON.parse(fs.readFileSync(lastPath, 'utf8'));
  if (b.split !== c.split) { log(`split mismatch: baseline=${b.split} current=${c.split}`); return 2; }
  const r = compareToBaseline(b.metrics, c.metrics);
  log(`precision@10 baseline=${b.metrics.precision_at_10} (${b.prompt}) current=${c.metrics.precision_at_10} (${c.prompt}) drop=${r.dropPts.toFixed(1)} pts`);
  if (!r.ok) { log('REGRESSION: precision@10 dropped more than 5 points'); return 1; }
  log('ok'); return 0;
}
if (process.argv[1]?.endsWith('compare.ts')) {
  const P = evalPaths();
  const split = process.argv.includes('--split') ? process.argv[process.argv.indexOf('--split') + 1] : 'heldout';
  process.exit(runCompare(`${P.results}/baseline-${split}.json`, `${P.results}/last-${split}.json`));
}
