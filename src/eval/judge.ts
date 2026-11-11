import 'dotenv/config';
import fs from 'node:fs';
import { scoreJob } from '../scoring/scorer.js';
import { budgetedLlm, summary } from '../spend.js';
import { evalPaths, dirProfileSummary } from './paths.js';
import { fakeScorerLlm } from './fakeLlm.js';
import { loadGold, requireApproval, jobsByKey, pool } from './common.js';
import { sha, judgeReason, pickSpotcheck, renderSpotcheckMd, type JudgedClaim } from './judgelib.js';

// usage: npm run judge -- --prompt vN     (15 fixed gold jobs; writes eval/results/judge.json + eval/judge_spotcheck.md)
const a = process.argv.slice(2);
const pv = a.includes('--prompt') ? a[a.indexOf('--prompt') + 1] : 'v3';
const P = evalPaths(), fake = a.includes('--fake-llm');
requireApproval(P);
const gold = loadGold(P).sort((x, y) => sha(x.key).localeCompare(sha(y.key))).slice(0, 15);
const jobs = jobsByKey(gold.map((g) => g.key), P);
const llm = fake ? fakeScorerLlm : budgetedLlm('B', `judge ${pv}`);
const profileSummary = dirProfileSummary(P);
const claims: JudgedClaim[] = (await pool(gold, 3, async (g) => {
  const j = jobs.get(g.key);
  const s = await scoreJob(j, llm, { promptVersion: pv, profileSummary });
  const out: JudgedClaim[] = [];
  for (const reason of s.fit_reasons) { const v = await judgeReason(reason, j.description, llm); out.push({ key: g.key, title: j.title, reason, ...v }); }
  return out;
})).flat();
const picks = pickSpotcheck(claims);
fs.mkdirSync(P.results, { recursive: true });
const valid = claims.filter((c) => c.supported !== null);
fs.writeFileSync(`${P.results}/judge.json`, JSON.stringify({
  prompt: pv, jobs: gold.length, claims: claims.length, supported: valid.filter((c) => c.supported).length,
  unsupported: valid.filter((c) => !c.supported).length, invalid: claims.length - valid.length,
  spotcheck_keys: picks.map((p) => ({ key: p.key, reason: p.reason, judge_supported: p.supported })), claims_detail: claims,
}, null, 1));
fs.writeFileSync(P.judgeSpot, renderSpotcheckMd(picks, new Map(gold.map((g) => [g.key, jobs.get(g.key).description]))));
console.log(`judged ${claims.length} fit_reasons on ${gold.length} jobs; spot-check file: ${P.judgeSpot} (${picks.length} items)`);
if (!fake) console.log(summary('B'));
