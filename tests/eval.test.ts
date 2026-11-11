import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEval } from '../src/eval/lib.js';
import { splitOf, type GoldRow, type Label } from '../src/eval/metrics.js';
import { runCompare } from '../src/eval/compare.js';
import { pickSpotcheck, renderSpotcheckMd, parseSpotcheckMd, judgeReason, type JudgedClaim } from '../src/eval/judgelib.js';

// Synthetic fixtures: 40 fake jobs; the fake LLM reads the label out of the title so no API key is needed.
const labels: Label[] = ['apply', 'maybe', 'skip', 'skip'];
const gold: GoldRow[] = Array.from({ length: 40 }, (_, i) => ({ key: `syn:${i}`, label: labels[i % 4], track: i % 2 ? 'B' : 'A' }));
const jobs = new Map(gold.map((g) => [g.key, { title: `${g.label.toUpperCase()} job ${g.key}`, company: 'Syn', location: 'NYC', description: `desc ${g.key}` }]));
let wobble = 0;
const fakeLlm = (opts: { noisy?: boolean } = {}) => async (_s: string, user: string) => {
  const hi = /APPLY job/.test(user), mid = /MAYBE job/.test(user);
  const track = /syn:\d*[13579]\b/.test(user) ? 'B' : 'A';
  let score = hi ? 90 : mid ? 65 : 10;
  if (opts.noisy && (wobble++ % 5 === 0)) score = score > 50 ? 20 : 80;
  return JSON.stringify({ score, track, fit_reasons: ['r'], gaps: [], apply_priority: score >= 75 ? 'high' : score >= 55 ? 'med' : 'low' });
};

describe('eval runner on synthetic fixtures', () => {
  it('splits by hash with reported counts that sum to n, and reports n per metric', async () => {
    const r = await runEval({ gold, jobs, llm: fakeLlm(), pv: 'v3', split: 'heldout', profileSummary: 'p' });
    expect(r.split_counts.dev + r.split_counts.heldout).toBe(40);
    expect(r.metrics.n).toBe(r.split_counts.heldout);
    expect(r.metrics.ns.label_agreement).toBe(r.metrics.n);
    expect(gold.filter((g) => splitOf(g.key) === 'heldout')).toHaveLength(r.split_counts.heldout);
  });
  it('perfect fake scorer: agreement 1, stdev 0, pass^3 consistency 1, precision@10 matches ground truth', async () => {
    const r = await runEval({ gold, jobs, llm: fakeLlm(), pv: 'v3', split: 'all', profileSummary: 'p' });
    const m = r.metrics;
    expect(m.label_agreement).toBe(1); expect(m.score_stdev).toBe(0); expect(m.pass3_consistency).toBe(1); expect(m.pass_pow_3_vs_gold).toBe(1);
    expect(m.track_accuracy).toBe(1);
    // positives = apply (10) + maybe (10) = 20; the top 10 by score are exactly the apply jobs, all positive
    expect(m.precision_at_10).toBe(1);
    expect(m.class_counts).toEqual({ apply: 10, maybe: 10, skip: 20 });
    expect(m.n_positive_worth_applying).toBe(20);
    expect(m.recall_at_15).toBe(15 / 20);       // 15 of 20 positives are in the top 15
    expect(m.strict_a_only_reported).toBe(true);
    expect(m.precision_at_10_strict_a).toBe(1); expect(m.recall_at_15_strict_a).toBe(1);
    expect(m.ci.label_agreement![0]).toBeGreaterThan(0.8);
  });
  it('every trial is a real call (no cache): k=3 means 3 calls per job', async () => {
    let calls = 0; const llm = fakeLlm();
    await runEval({ gold: gold.slice(0, 5), jobs, llm: async (s, u) => { calls++; return llm(s, u); }, pv: 'v3', split: 'all', k: 3, profileSummary: 'p' });
    expect(calls).toBe(15);
  });
  it('noisy scorer lowers pass^3 consistency', async () => {
    const r = await runEval({ gold, jobs, llm: fakeLlm({ noisy: true }), pv: 'v3', split: 'all', profileSummary: 'p' });
    expect(r.metrics.pass3_consistency).toBeLessThan(1);
    expect(r.metrics.score_stdev).toBeGreaterThan(0);
  });
  it('invalid model output is counted as dropped, not silently scored', async () => {
    const r = await runEval({ gold: gold.slice(0, 4), jobs, llm: async () => 'garbage', pv: 'v3', split: 'all', profileSummary: 'p' });
    expect(r.dropped_jobs_due_to_invalid_output).toBe(4); expect(r.failures.length).toBeGreaterThan(0);
  });
});

describe('eval:compare', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  const w = (n: string, p10: number, split = 'heldout') => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify({ prompt: n, split, metrics: { precision_at_10: p10 } })); return f; };
  it('exit 1 when precision@10 drops more than 5 points, 0 otherwise', () => {
    const quiet = () => {};
    expect(runCompare(w('b', 0.8), w('c1', 0.74), quiet)).toBe(1);
    expect(runCompare(w('b', 0.8), w('c2', 0.76), quiet)).toBe(0);
    expect(runCompare(w('b', 0.8), w('c3', 0.9), quiet)).toBe(0);
    expect(runCompare(w('b', 0.8), w('c4', 0.8, 'dev'), quiet)).toBe(2);
    expect(runCompare(path.join(dir, 'nope'), w('c5', 0.8), quiet)).toBe(2);
  });
});

describe('judge pieces', () => {
  const claims: JudgedClaim[] = Array.from({ length: 15 }, (_, i) => ({ key: `k${i}`, title: `T${i}`, reason: `reason ${i}`, supported: i % 3 !== 0, evidence: i % 3 ? 'quote' : '' }));
  it('picks exactly 10 deterministic, skips invalid verdicts', () => {
    const picks = pickSpotcheck([...claims, { key: 'bad', title: 'x', reason: 'y', supported: null, evidence: '' }]);
    expect(picks).toHaveLength(10); expect(picks.find((p) => p.key === 'bad')).toBeUndefined();
    expect(pickSpotcheck(claims).map((p) => p.key)).toEqual(pickSpotcheck([...claims].reverse()).map((p) => p.key));
  });
  it('agreement parser: blank is flagged, filled counts agree/disagree', () => {
    const md = renderSpotcheckMd(pickSpotcheck(claims), new Map(claims.map((c) => [c.key, 'text'])));
    expect(parseSpotcheckMd(md)).toMatchObject({ items: 10, blank: 10, agree: 0 });
    let i = 0;
    const filled = md.replace(/^Your call \(agree \/ disagree\):.*$/gm, () => `Your call (agree / disagree): ${i++ < 8 ? 'agree' : 'disagree'}`);
    expect(parseSpotcheckMd(filled)).toMatchObject({ items: 10, agree: 8, disagree: 2, blank: 0, invalid: 0 });
  });
  it('judge output is zod-validated; junk becomes null verdict', async () => {
    expect(await judgeReason('c', 'd', async () => '{"supported":true,"evidence":"q"}')).toEqual({ supported: true, evidence: 'q' });
    expect((await judgeReason('c', 'd', async () => 'I think yes')).supported).toBeNull();
    expect((await judgeReason('c', 'd', async () => '{"supported":true,"evidence":"q","x":1}')).supported).toBeNull();
  });
});

describe('spend cap', () => {
  it('ledger refuses a call that would pass the cap, without any API call', async () => {
    const f = path.join(os.tmpdir(), `spend-${Date.now()}.json`);
    process.env.SPEND_FILE = f; process.env.PRICE_IN_PER_MTOK = '2'; process.env.PRICE_OUT_PER_MTOK = '10'; process.env.ANTHROPIC_API_KEY = 'x-test';
    fs.writeFileSync(f, JSON.stringify({ phases: { B: { cap_usd: 0.001, spent_usd: 0.001 } }, log: [] }));
    const { budgetedLlm, BudgetError } = await import('../src/spend.js');
    await expect(budgetedLlm('B', 't')('sys', 'user')).rejects.toBeInstanceOf(BudgetError);
  });
});
