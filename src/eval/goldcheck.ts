import fs from 'node:fs';
import { evalPaths } from './paths.js';

export interface Check { name: string; ok: boolean; detail: string }
/** Sanity checks on a labeled gold set. strata: key -> stratum. */
export function checkGold(gold: { key: string; label: string; labeled_at: string; labeler?: string }[], strata: Map<string, string>, expectedN = 60): Check[] {
  const n = gold.length, cnt: Record<string, number> = {};
  gold.forEach((g) => (cnt[g.label] = (cnt[g.label] ?? 0) + 1));
  const top = Math.max(0, ...Object.values(cnt)) / (n || 1);
  // pace is only meaningful for human labels (proxy rows are written in bulk)
  const humanRows = gold.filter((g) => g.labeler === undefined || g.labeler === 'human');
  const ts = humanRows.map((g) => Date.parse(g.labeled_at)).sort((a, b) => a - b);
  const avgSec = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) / 1000 : 0;
  const skips = gold.filter((g) => strata.get(g.key) === 'obvious-skip');
  const skipAsApply = skips.filter((g) => g.label === 'apply').length;
  return [
    { name: 'count', ok: n === expectedN && new Set(gold.map((g) => g.key)).size === n && gold.every((g) => strata.has(g.key)), detail: `${n} labels, ${new Set(gold.map((g) => g.key)).size} unique, all keys in candidates=${gold.every((g) => strata.has(g.key))}` },
    { name: 'balance (no label >70%)', ok: top <= 0.7, detail: `counts ${JSON.stringify(cnt)}; top share ${(top * 100).toFixed(0)}%` },
    { name: 'pace (human labels: avg >= 4s per label)', ok: avgSec >= 4 || humanRows.length < 2, detail: `${humanRows.length} human labels, average ${avgSec.toFixed(1)}s between labels` },
    { name: 'labeler field on every row', ok: gold.every((g) => g.labeler === 'human' || g.labeler === 'ai-proxy'), detail: `human=${humanRows.length}, ai-proxy=${gold.filter((g) => g.labeler === 'ai-proxy').length}` },
    { name: 'obvious skips (<=30% labeled apply)', ok: skips.length === 0 || skipAsApply / skips.length <= 0.3, detail: `${skipAsApply}/${skips.length} obvious-skip jobs labeled apply (human-labeled: ${skips.filter((g) => g.labeler === 'human' && g.label === 'apply').length}/${skips.filter((g) => g.labeler === 'human').length})` },
  ];
}
if (process.argv[1]?.endsWith('goldcheck.ts')) {
  const P = evalPaths();
  const gold = fs.readFileSync(P.gold, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const strata = new Map(fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((c) => [c.key, c.stratum] as [string, string]));
  const checks = checkGold(gold, strata, strata.size);
  checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`));
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
