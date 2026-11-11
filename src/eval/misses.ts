import fs from 'node:fs';
import { evalPaths } from './paths.js';
import { mean, priorityToLabel } from './metrics.js';
import { BANDS } from '../scoring/prompts.js';

// npm run misses -- [results-file]   — the N worst disagreements between the scorer's mean score and the gold label's band.
const P = evalPaths();
const file = process.argv[2] ?? `${P.results}/last-heldout.json`;
const N = Number(process.argv[3] ?? 10);
const res = JSON.parse(fs.readFileSync(file, 'utf8'));
const gold = new Map(fs.readFileSync(P.gold, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((g) => [g.key, g]));
const snaps = new Map(fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((c) => [c.key, c.snapshot]));
// band for each gold label (same bands the prompts state): apply >= 70, maybe 40-69, skip < 40
const band: Record<string, [number, number]> = { apply: [BANDS.high, 100], maybe: [BANDS.med, BANDS.high - 1], skip: [0, BANDS.med - 1] };
const rows = res.jobs.map((j: any) => {
  const m = mean(j.trials.map((t: any) => t.score));
  const [lo, hi] = band[j.gold_label];
  const err = m < lo ? lo - m : m > hi ? m - hi : 0;
  return { key: j.key, gold: j.gold_label, mean: m, err, trials: j.trials, direction: err === 0 ? 'ok' : m > hi ? 'scorer too high (false positive)' : 'scorer too low (false negative)' };
}).sort((a: any, b: any) => b.err - a.err).slice(0, N);
const out = rows.map((r: any) => {
  const s = snaps.get(r.key), g = gold.get(r.key);
  return { ...r, title: s.title, company: s.company, location: s.location, proxy_reason: g.proxy_reason, proxy_evidence: g.proxy_evidence, stratum: undefined };
});
fs.writeFileSync(`${P.results}/misses.json`, JSON.stringify(out, null, 1));
for (const [i, r] of out.entries()) {
  console.log(`\n#${i + 1} err=${r.err.toFixed(0)} ${r.direction}\n  ${r.company} | ${r.title} | ${r.location}\n  gold=${r.gold}  scorer mean=${r.mean.toFixed(0)} scores=[${r.trials.map((t: any) => t.score)}] priorities=[${r.trials.map((t: any) => t.apply_priority)}]\n  proxy reason: ${r.proxy_reason}\n  proxy evidence: "${r.proxy_evidence}"\n  scorer reasons: ${r.trials[0].fit_reasons.join(' || ').slice(0, 450)}\n  scorer gaps: ${r.trials[0].gaps.join(' || ').slice(0, 450)}`);
}
