import 'dotenv/config';
import fs from 'node:fs';
import { evalPaths } from './paths.js';
import { budgetedLlm, summary } from '../spend.js';
import { loadProfile } from '../scoring/scorer.js';
import { pool } from './common.js';
import { proxyLabel, goldSafeguards, LABEL_NAME, PROXY_HASH } from './proxylib.js';

// npm run proxy — AI-proxy labels every frozen candidate (cached by key + prompt hash), then builds eval/gold.jsonl
// if the safeguards pass. Every gold row carries labeler: "ai-proxy". Human "would apply" labels are NOT used.
const P = evalPaths();
const LF = P.proxyLabels;
const cands = fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const prev = new Map<string, any>((fs.existsSync(LF) ? fs.readFileSync(LF, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r) => r.prompt_hash === PROXY_HASH && r.evidence).map((r) => [r.key, r]));
const todo = cands.filter((c) => !prev.has(c.key));
console.log(`proxy prompt ${PROXY_HASH}: ${prev.size} cached, ${todo.length} to label`);
const profile = loadProfile().summary;
const llm = budgetedLlm('PROXY2', 'proxy labeling');
const fresh = await pool(todo, 4, async (c) => {
  try { return { key: c.key, ...(await proxyLabel(c.snapshot, llm, profile)), prompt_hash: PROXY_HASH, labeled_at: new Date().toISOString() }; }
  catch (e) { return { key: c.key, error: (e as Error).message } as any; }
});
const errors = fresh.filter((f: any) => f.error);
const all = new Map(prev); fresh.filter((f: any) => !f.error).forEach((f: any) => all.set(f.key, f));
fs.writeFileSync(LF, [...all.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');

const gold = cands.filter((c) => all.has(c.key)).map((c) => {
  const p = all.get(c.key);
  return { key: c.key, label: LABEL_NAME[p.label as 'a' | 'm' | 's'], track: p.track, labeled_at: p.labeled_at, labeler: 'ai-proxy', proxy_reason: p.reason, proxy_evidence: p.evidence };
});
const sg = goldSafeguards(gold.map((g) => g.label));
const strata: Record<string, Record<string, number>> = {};
cands.forEach((c) => { const p = all.get(c.key); if (!p) return; strata[c.stratum] ??= {}; strata[c.stratum][p.label] = (strata[c.stratum][p.label] ?? 0) + 1; });
const report = { timestamp: new Date().toISOString(), proxy_prompt_hash: PROXY_HASH, candidates: cands.length, labeled: gold.length, proxy_errors: errors.length, errors: errors.map((e: any) => `${e.key}: ${e.error}`), safeguards: sg, by_stratum_a_m_s: strata };
fs.mkdirSync(P.results, { recursive: true });
fs.writeFileSync(`${P.results}/proxy_labels_report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
console.log(summary('PROXY2'));
if (sg.ok && gold.length === cands.length) { fs.writeFileSync(P.gold, gold.map((g) => JSON.stringify(g)).join('\n') + '\n'); console.log(`safeguards passed; wrote ${P.gold}`); }
else console.log(`SAFEGUARD FAILED (or labels missing): ${P.gold} NOT written`);
