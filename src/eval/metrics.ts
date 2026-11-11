import crypto from 'node:crypto';
import type { Score } from '../scoring/schema.js';
import { priorityFromScore } from '../scoring/prompts.js';

export type Label = 'apply' | 'maybe' | 'skip';
export interface GoldRow { key: string; label: Label; track: 'A' | 'B' }
export interface JobTrials { gold: GoldRow; trials: Score[] }

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const stdev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); }; // population sd
/** Scorer says "worth applying" when priority is high or med. */
export const scorerApplies = (s: Score) => s.apply_priority !== 'low';
/** Rubric mapping: high = apply, med = maybe, low = skip. */
export const priorityToLabel = (p: Score['apply_priority']): Label => (p === 'high' ? 'apply' : p === 'med' ? 'maybe' : 'skip');
export const goldApplies = (l: Label) => l !== 'skip';

/** Deterministic dev/held-out split by hash of the job key. */
export function splitOf(key: string): 'dev' | 'heldout' {
  return parseInt(crypto.createHash('sha1').update('split:' + key).digest('hex').slice(0, 8), 16) % 2 === 0 ? 'dev' : 'heldout';
}

/** Wilson 95% interval for a proportion. */
export function wilson95(p: number, n: number): [number, number] | null {
  if (!n || Number.isNaN(p)) return null;
  const z = 1.96, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

export function computeMetrics(rows: JobTrials[]) {
  const avg = rows.map((r) => ({ ...r, mean: mean(r.trials.map((t) => t.score)) }));
  const ranked = [...avg].sort((a, b) => b.mean - a.mean);
  const isPos = (r: JobTrials) => goldApplies(r.gold.label);            // positive class = worth applying (a OR m)
  const nPos = rows.filter(isPos).length;
  const nA = rows.filter((r) => r.gold.label === 'apply').length;
  const class_counts = { apply: nA, maybe: rows.filter((r) => r.gold.label === 'maybe').length, skip: rows.filter((r) => r.gold.label === 'skip').length };
  const strictOk = nA >= 10;                                              // strict a-only metrics only reported with >= 10 'a' labels
  const top = (k: number) => ranked.slice(0, k);
  const agree = rows.map((r) => {
    const majority = r.trials.filter(scorerApplies).length * 2 > r.trials.length;
    return majority === goldApplies(r.gold.label);
  });
  const trackRows = rows.filter((r) => r.gold.label !== 'skip');
  const trackOk = trackRows.map((r) => {
    const a = r.trials.filter((t) => t.track === 'A').length;
    return (a * 2 > r.trials.length ? 'A' : 'B') === r.gold.track;
  });
  const consistent = rows.map((r) => new Set(r.trials.map(scorerApplies)).size === 1);
  const matchesGold = rows.map((r) => r.trials.map((t) => scorerApplies(t) === goldApplies(r.gold.label)));
  const frac = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : NaN);
  // exact 3-class agreement: majority priority across trials (ties -> the more cautious/lower one) vs gold label
  const order: Score['apply_priority'][] = ['low', 'med', 'high'];
  const exact = rows.map((r) => {
    const c = order.map((o) => r.trials.filter((t) => t.apply_priority === o).length);
    const best = Math.max(...c);
    return priorityToLabel(order[c.indexOf(best)]) === r.gold.label;
  });
  const allTrials = rows.flatMap((r) => r.trials);
  const consistencyFrac = allTrials.length ? allTrials.filter((t) => t.apply_priority === priorityFromScore(t.score)).length / allTrials.length : NaN;
  const label_agreement = frac(agree), track_accuracy = frac(trackOk), pass3_consistency = frac(consistent);
  return {
    // n behind every metric; ci = Wilson 95% interval where the metric is a proportion
    ns: { exact_agreement_3class: rows.length, priority_score_consistency: allTrials.length, label_agreement: rows.length, precision_at_10: Math.min(10, rows.length), recall_at_15: nPos, track_accuracy: trackRows.length, score_stdev: rows.length, pass3_consistency: rows.length },
    ci: { label_agreement: wilson95(label_agreement, rows.length), track_accuracy: wilson95(track_accuracy, trackRows.length), pass3_consistency: wilson95(pass3_consistency, rows.length) },
    n: rows.length,
    class_counts,
    n_positive_worth_applying: nPos,
    strict_a_only_reported: strictOk,
    strict_a_only_omitted_reason: strictOk ? null : `only ${nA} 'a' labels (< 10 needed)`,
    label_agreement,                 // binary: scorer high/med vs gold apply/maybe
    exact_agreement_3class: frac(exact),   // high=apply, med=maybe, low=skip
    priority_score_consistency: consistencyFrac, // share of trials whose apply_priority matches the score band
    precision_at_10: top(10).filter(isPos).length / Math.min(10, rows.length),
    recall_at_15: nPos ? top(15).filter(isPos).length / nPos : NaN,
    precision_at_10_strict_a: strictOk ? top(10).filter((r) => r.gold.label === 'apply').length / Math.min(10, rows.length) : null,
    recall_at_15_strict_a: strictOk ? top(15).filter((r) => r.gold.label === 'apply').length / nA : null,
    track_accuracy,
    track_n: trackRows.length,
    score_stdev: mean(rows.map((r) => stdev(r.trials.map((t) => t.score)))),
    pass3_consistency,            // all k trials give the same apply decision
    pass_at_3_vs_gold: frac(matchesGold.map((m) => m.some(Boolean))),
    pass_pow_3_vs_gold: frac(matchesGold.map((m) => m.every(Boolean))),
  };
}
export type Metrics = ReturnType<typeof computeMetrics>;

/** Regression gate: fails when precision@10 drops more than maxDropPoints percentage points. */
export function compareToBaseline(baseline: Metrics, current: Metrics, maxDropPoints = 5) {
  const dropPts = (baseline.precision_at_10 - current.precision_at_10) * 100;
  return { ok: !(dropPts > maxDropPoints), dropPts };
}
