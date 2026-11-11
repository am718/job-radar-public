import fs from 'node:fs';
import { evalPaths } from './paths.js';
import crypto from 'node:crypto';
import { parseSpotcheckMd } from './judgelib.js';

const h = (s: string) => crypto.createHash('sha1').update('proxyspot' + s).digest('hex');
export function pickProxySpot(gold: any[], humanApplyKeys: Set<string>, n = 10, minFromHuman = 5) {
  const sorted = (xs: any[]) => [...xs].sort((a, b) => h(a.key).localeCompare(h(b.key)));
  const dis = sorted(gold.filter((g) => humanApplyKeys.has(g.key) && g.label !== 'apply'));
  const first = dis.slice(0, minFromHuman);
  const rest = sorted(gold.filter((g) => !first.includes(g))).slice(0, n - first.length);
  return sorted([...first, ...rest]);
}
export function renderProxySpot(items: { gold: any; snap: any; humanApply: boolean }[]) {
  const out = ['# Proxy spot-check (PENDING your review)', '',
    'The AI proxy produced the gold labels using the interview-likelihood rubric. For each item, decide whether YOU agree with the proxy\'s label under the rubric:',
    '- a = Track A or B, meets the stated requirements, would expect an interview',
    '- m = stretch (missing one or two requirements) or an adjacent role you would take',
    '- s = missing a hard requirement (license, degree, years) or a different field entirely', '',
    'Fill in the blank after "Your call:" with exactly `agree` or `disagree`. Items marked [you labeled this "would apply"] are jobs where your earlier hand label was apply.', ''];
  items.forEach(({ gold, snap, humanApply }, i) => out.push(
    `## Item ${i + 1}: ${snap.title} @ ${snap.company}${humanApply ? '  [you labeled this "would apply"]' : ''}`,
    `Location: ${snap.location}`, `Proxy label: **${gold.label}** (track ${gold.track})`, `Requirement sentence quoted from the posting: "${gold.proxy_evidence}"`, `Proxy reason: ${gold.proxy_reason}`,
    '', '<details><summary>Full posting text</summary>', '', snap.description.slice(0, 6000), '', '</details>', '', 'Your call (agree / disagree):', '', '---', ''));
  return out.join('\n');
}
if (process.argv[1]?.endsWith('proxySpot.ts')) {
  const P = evalPaths();
  const gold = fs.readFileSync(P.gold, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const snaps = new Map(fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((c) => [c.key, c.snapshot]));
  const human = new Set(fs.readFileSync(P.humanLabels, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.label === 'apply').map((r) => r.key));
  const picks = pickProxySpot(gold, human);
  fs.writeFileSync(P.proxySpot, renderProxySpot(picks.map((g) => ({ gold: g, snap: snaps.get(g.key), humanApply: human.has(g.key) }))));
  console.log(`wrote ${P.proxySpot}: ${picks.length} items, ${picks.filter((g) => human.has(g.key) && g.label !== 'apply').length} on jobs you labeled apply where the proxy said m/s`);
}
