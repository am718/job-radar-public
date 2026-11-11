import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runEval } from '../src/eval/lib.js';
import { loadGold, jobsByKey } from '../src/eval/common.js';
import { evalPaths, resolveEvalDir, dirProfileSummary, SAMPLE_DIR } from '../src/eval/paths.js';
import { fakeScorerLlm } from '../src/eval/fakeLlm.js';
import { checkGold } from '../src/eval/goldcheck.js';

const underPrivate = (p: string) => path.resolve(p).split(path.sep).join('/').includes('/eval/private');

describe('data dir selection', () => {
  it('EVAL_DIR wins, then --sample, then eval/private if present, else the sample', () => {
    expect(resolveEvalDir(['x'], { EVAL_DIR: '/tmp/d' } as any, () => true)).toBe('/tmp/d');
    expect(resolveEvalDir(['x', '--sample'], {} as any, () => true)).toBe(SAMPLE_DIR);
    expect(resolveEvalDir(['x'], {} as any, (p) => p === 'eval/private')).toBe('eval/private');
    expect(resolveEvalDir(['x'], {} as any, () => false)).toBe(SAMPLE_DIR);
  });
  it('every path of a data dir lives inside it', () => {
    const p = evalPaths(SAMPLE_DIR);
    for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && k !== 'dir') expect(v.startsWith(SAMPLE_DIR + '/'), k).toBe(true);
  });
});

describe('harness on the synthetic sample (fake scorer, no network)', () => {
  const P = evalPaths(SAMPLE_DIR);

  it('runs end to end, returns the metrics shape, and opens nothing under eval/private', async () => {
    const opened: string[] = [];
    const o = { r: fs.readFileSync, o: fs.openSync, e: fs.existsSync, d: fs.readdirSync };
    const rec = (f: any) => (...a: any[]) => { opened.push(String(a[0])); return f(...a); };
    (fs as any).readFileSync = rec(o.r); (fs as any).openSync = rec(o.o); (fs as any).existsSync = rec(o.e); (fs as any).readdirSync = rec(o.d);
    let res;
    try {
      const gold = loadGold(P);
      const jobs = jobsByKey(gold.map((g) => g.key), P);
      res = await runEval({ gold, jobs, llm: fakeScorerLlm, pv: 'v3', split: 'all', k: 3, profileSummary: dirProfileSummary(P) });
    } finally { Object.assign(fs, { readFileSync: o.r, openSync: o.o, existsSync: o.e, readdirSync: o.d }); }

    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter(underPrivate)).toEqual([]);
    expect(opened.some((f) => f.includes('eval/sample'))).toBe(true);

    const m = res.metrics;
    expect(m.n).toBe(res.jobs.length);
    expect(m.n).toBeGreaterThanOrEqual(25);
    expect(res.dropped_jobs_due_to_invalid_output).toBe(0);
    expect(m.class_counts.apply + m.class_counts.maybe + m.class_counts.skip).toBe(m.n);
    for (const key of ['label_agreement', 'exact_agreement_3class', 'precision_at_10', 'recall_at_15', 'track_accuracy', 'pass3_consistency', 'score_stdev'] as const) {
      expect(typeof m[key], key).toBe('number');
      expect(Number.isNaN(m[key]), key).toBe(false);
    }
    expect(m.ns.precision_at_10).toBe(10);
    expect(m.label_agreement).toBeGreaterThan(0.5);
    expect(m.label_agreement).toBeLessThan(1);   // the fake scorer is deliberately imperfect
    expect(m.ci.label_agreement).toHaveLength(2);
  });

  it('is deterministic', async () => {
    const gold = loadGold(P), jobs = jobsByKey(gold.map((g) => g.key), P);
    const run = () => runEval({ gold, jobs, llm: fakeScorerLlm, pv: 'v3', split: 'heldout', k: 2, profileSummary: 'p' });
    expect((await run()).metrics).toEqual((await run()).metrics);
  });

  it('sample gold passes the gold sanity checks and quotes verbatim evidence', () => {
    const gold = fs.readFileSync(P.gold, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const cands = fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const strata = new Map(cands.map((c) => [c.key, c.stratum] as [string, string]));
    expect(checkGold(gold, strata, strata.size).filter((c) => !c.ok)).toEqual([]);
    const desc = new Map(cands.map((c) => [c.key, c.snapshot.description as string]));
    for (const g of gold) expect(desc.get(g.key)).toContain(g.proxy_evidence);
    for (const c of cands) expect(c.snapshot.url).toContain('example.com');
  });
});
