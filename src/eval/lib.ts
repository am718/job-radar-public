import { scoreJob, cacheVersion, type LlmFn } from '../scoring/scorer.js';
import { computeMetrics, splitOf, type GoldRow, type JobTrials } from './metrics.js';
import { pool } from './common.js';
import { PROMPTS } from '../scoring/prompts.js';

export interface EvalResult {
  prompt: string; cache_version: string; split: string; k: number; timestamp: string;
  split_counts: { dev: number; heldout: number };
  dropped_jobs_due_to_invalid_output: number; failures: string[];
  metrics: ReturnType<typeof computeMetrics>;
  jobs: { key: string; gold_label: string; gold_track: string; trials: any[] }[];
}

/** Runs k fresh trials per job (the cache is deliberately bypassed: every trial is a real call). */
export async function runEval(opts: {
  gold: GoldRow[]; jobs: Map<string, any>; llm: LlmFn; pv: string; split: 'dev' | 'heldout' | 'all'; k?: number; profileSummary?: string; concurrency?: number;
}): Promise<EvalResult> {
  const k = opts.k ?? 3;
  const counts = { dev: opts.gold.filter((g) => splitOf(g.key) === 'dev').length, heldout: opts.gold.filter((g) => splitOf(g.key) === 'heldout').length };
  const gold = opts.gold.filter((g) => opts.split === 'all' || splitOf(g.key) === opts.split);
  const failures: string[] = [];
  const rows = (await pool(gold, opts.concurrency ?? 4, async (g): Promise<JobTrials | null> => {
    const j = opts.jobs.get(g.key);
    const trials = [];
    for (let t = 0; t < k; t++) {
      try { trials.push(await scoreJob(j, opts.llm, { promptVersion: opts.pv, profileSummary: opts.profileSummary })); }
      catch (e) { failures.push(`${g.key} trial ${t}: ${(e as Error).message}`); if ((e as Error).name === 'BudgetError') throw e; }
    }
    return trials.length === k ? { gold: g, trials } : null;
  })).filter(Boolean) as JobTrials[];
  return {
    prompt: opts.pv, cache_version: cacheVersion(opts.pv, opts.profileSummary), split: opts.split, k, timestamp: new Date().toISOString(),
    split_counts: counts, dropped_jobs_due_to_invalid_output: gold.length - rows.length, failures,
    metrics: computeMetrics(rows),
    jobs: rows.map((r) => ({ key: r.gold.key, gold_label: r.gold.label, gold_track: r.gold.track, trials: r.trials })),
  };
}
export const knownPrompt = (pv: string) => { if (!PROMPTS[pv]) throw new Error(`unknown prompt ${pv}`); };
