import { describe, it, expect } from 'vitest';
import { computeMetrics, compareToBaseline, splitOf, stdev, type JobTrials, type Label } from '../src/eval/metrics.js';

const sc = (score: number, pr: 'high' | 'med' | 'low', track: 'A' | 'B' = 'A') => ({ score, track, fit_reasons: [], gaps: [], apply_priority: pr });
const row = (label: Label, scores: [number, 'high' | 'med' | 'low'][], track: 'A' | 'B' = 'A'): JobTrials =>
  ({ gold: { key: Math.random().toString(), label, track }, trials: scores.map(([s, p]) => sc(s, p, track)) });

describe('metrics', () => {
  it('maybe counts as a positive (worth applying) for precision@10 and recall@15', () => {
    const rows = [row('apply', [[90, 'high'], [90, 'high'], [90, 'high']]), row('maybe', [[60, 'med'], [60, 'med'], [60, 'med']]), row('skip', [[5, 'low'], [5, 'low'], [5, 'low']])];
    const m = computeMetrics(rows);
    expect(m.precision_at_10).toBeCloseTo(2 / 3); expect(m.recall_at_15).toBe(1);
  });
  it('perfect scorer', () => {
    const rows = [row('apply', [[90, 'high'], [90, 'high'], [90, 'high']]), row('skip', [[10, 'low'], [10, 'low'], [10, 'low']])];
    const m = computeMetrics(rows);
    expect(m.label_agreement).toBe(1); expect(m.precision_at_10).toBe(0.5); expect(m.recall_at_15).toBe(1);
    expect(m.strict_a_only_reported).toBe(false); expect(m.strict_a_only_omitted_reason).toMatch(/only 1/); expect(m.precision_at_10_strict_a).toBeNull();
    expect(m.pass3_consistency).toBe(1); expect(m.score_stdev).toBe(0); expect(m.pass_pow_3_vs_gold).toBe(1);
  });
  it('unstable job lowers pass^3 but not pass@3', () => {
    const m = computeMetrics([row('apply', [[80, 'high'], [40, 'low'], [80, 'high']])]);
    expect(m.pass3_consistency).toBe(0); expect(m.pass_at_3_vs_gold).toBe(1); expect(m.pass_pow_3_vs_gold).toBe(0);
    expect(m.score_stdev).toBeCloseTo(stdev([80, 40, 80]));
  });
  it('regression gate fails on >5pt drop, passes on exactly 5', () => {
    const b: any = { precision_at_10: 0.8 };
    expect(compareToBaseline(b, { precision_at_10: 0.74 } as any).ok).toBe(false);
    expect(compareToBaseline(b, { precision_at_10: 0.76 } as any).ok).toBe(true);
  });
  it('split is deterministic and roughly balanced', () => {
    expect(splitOf('a:1')).toBe(splitOf('a:1'));
    const n = Array.from({ length: 200 }, (_, i) => splitOf('k' + i)).filter((x) => x === 'dev').length;
    expect(n).toBeGreaterThan(70); expect(n).toBeLessThan(130);
  });
});
