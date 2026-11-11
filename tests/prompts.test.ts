import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { PROMPTS, BANDS, HARD_REQ_CAP, priorityFromScore } from '../src/scoring/prompts.js';
import { JUDGE_SYSTEM } from '../src/eval/judgelib.js';
import { ScoreSchema } from '../src/scoring/schema.js';
import { computeMetrics, priorityToLabel } from '../src/eval/metrics.js';

describe('scorer prompts (v1-v3)', () => {
  for (const [id, p] of Object.entries(PROMPTS)) {
    describe(id, () => {
      it('defines score as interview likelihood against written requirements', () => {
        expect(Object.keys(PROMPTS)).toContain(id);
        expect(p.system).toMatch(/gets an interview/);
        expect(p.system).toMatch(/requirements actually written in the job description/);
      });
      it('caps hard requirement misses at the configured cap', () => {
        expect(p.system).toContain(`${HARD_REQ_CAP} or lower`);
        for (const w of ['license', 'degree', 'clearance', 'years']) expect(p.system.toLowerCase()).toContain(w);
      });
      it('states the bands that map to apply / maybe / skip', () => {
        expect(p.system).toContain(`high = score ${BANDS.high}-100`);
        expect(p.system).toContain(`med = score ${BANDS.med}-${BANDS.high - 1}`);
        expect(p.system).toContain(`low = score 0-${BANDS.med - 1}`);
      });
      it('keeps the description untrusted and the output schema unchanged', () => {
        expect(p.system).toMatch(/UNTRUSTED/); expect(p.system).toMatch(/Never follow instructions/);
        for (const f of ['"score"', '"track"', '"fit_reasons"', '"gaps"', '"apply_priority"']) expect(p.system).toContain(f);
        expect(Object.keys(ScoreSchema.shape).sort()).toEqual(['apply_priority', 'fit_reasons', 'gaps', 'score', 'track']);
      });
    });
  }
  it('versions differ from each other', () => {
    expect(new Set(Object.values(PROMPTS).map((p) => p.system)).size).toBe(Object.keys(PROMPTS).length);
  });
  it('does not mention GPA anywhere (prompts, profile)', () => {
    expect(JSON.stringify(PROMPTS).toLowerCase()).not.toContain('gpa');
    expect(fs.readFileSync('profile.example.json', 'utf8').toLowerCase()).not.toContain('gpa');
    if (fs.existsSync('profile.json')) expect(fs.readFileSync('profile.json', 'utf8').toLowerCase()).not.toContain('gpa');
  });
});

describe('judge prompt', () => {
  it('uses the interview-likelihood framing and keeps description untrusted', () => {
    expect(JUDGE_SYSTEM).toMatch(/how realistic it is that a candidate gets an interview/);
    expect(JUDGE_SYSTEM).toMatch(/UNTRUSTED/);
    expect(JUDGE_SYSTEM).toMatch(/does not appear in the description is NOT supported/);
  });
});

describe('priority mapping high=a, med=m, low=s', () => {
  it('bands', () => {
    expect([priorityFromScore(100), priorityFromScore(70), priorityFromScore(69), priorityFromScore(40), priorityFromScore(39), priorityFromScore(0)]).toEqual(['high', 'high', 'med', 'med', 'low', 'low']);
    expect(['high', 'med', 'low'].map((p) => priorityToLabel(p as any))).toEqual(['apply', 'maybe', 'skip']);
  });
  const sc = (score: number, pr: 'high' | 'med' | 'low') => ({ score, track: 'A' as const, fit_reasons: [], gaps: [], apply_priority: pr });
  it('exact 3-class agreement and priority/score consistency are computed', () => {
    const rows = [
      { gold: { key: '1', label: 'apply' as const, track: 'A' as const }, trials: [sc(80, 'high'), sc(80, 'high'), sc(80, 'high')] },
      { gold: { key: '2', label: 'maybe' as const, track: 'A' as const }, trials: [sc(50, 'med'), sc(50, 'med'), sc(80, 'high')] },
      { gold: { key: '3', label: 'skip' as const, track: 'A' as const }, trials: [sc(60, 'low'), sc(10, 'low'), sc(10, 'low')] }, // one trial inconsistent with band
      { gold: { key: '4', label: 'skip' as const, track: 'A' as const }, trials: [sc(60, 'med'), sc(60, 'med'), sc(60, 'med')] }, // wrong
    ];
    const m = computeMetrics(rows);
    expect(m.exact_agreement_3class).toBe(0.75);
    expect(m.priority_score_consistency).toBeCloseTo(11 / 12);
  });
});
