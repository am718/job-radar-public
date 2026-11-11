import type Database from 'better-sqlite3';
import { jobKey, type Job } from '../types.js';
import { dedupHash, getCachedScore, putScore } from '../store.js';
import { processJobs, type ScanStats } from '../pipeline.js';
import { scoreJob, cacheVersion, type LlmFn } from '../scoring/scorer.js';
import { DEFAULT_PROMPT } from '../scoring/prompts.js';

export interface StoreOutcome { job: Job; key: string; status: 'new' | 'updated' | 'dup'; filterReason?: string | null; score?: number; error?: string }

/** Stores jobs through the normal pipeline (prefilter, location, pay) and scores ONLY these jobs (processJobs would also score every other pending row, spending budget on unrelated jobs). */
export async function storeAndScore(db: Database.Database, jobs: Job[], llm: LlmFn | null, stats: ScanStats): Promise<StoreOutcome[]> {
  const uniq = [...new Map(jobs.map((j) => [jobKey(j), j])).values()];
  const keyExists = (k: string) => !!db.prepare('SELECT 1 FROM jobs WHERE key=?').get(k);
  const before = new Map(uniq.map((j) => [jobKey(j), keyExists(jobKey(j))]));
  const local: ScanStats = { fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] };
  await processJobs(db, uniq, null, local);
  stats.fetched += local.fetched; stats.filtered += local.filtered; stats.newJobs += local.newJobs;
  const out: StoreOutcome[] = [];
  const cv = cacheVersion(DEFAULT_PROMPT);
  for (const j of uniq) {
    const key = jobKey(j);
    const row = db.prepare('SELECT key, filter_reason, status FROM jobs WHERE key=?').get(key) as { key: string; filter_reason: string | null; status: string } | undefined;
    if (!row) {   // same company/title/location already stored under another key
      const ex = db.prepare('SELECT key FROM jobs WHERE dedup_hash=?').get(dedupHash(j)) as { key: string } | undefined;
      out.push({ job: j, key: ex?.key ?? key, status: 'dup' });
      continue;
    }
    const o: StoreOutcome = { job: j, key, status: before.get(key) ? 'updated' : 'new', filterReason: row.filter_reason };
    const cached = getCachedScore(db, key, cv);
    if (cached) o.score = cached.score;
    out.push(o);
  }
  if (llm) {
    const todo = out.filter((o) => o.status !== 'dup' && !o.filterReason && o.score == null && (db.prepare('SELECT status FROM jobs WHERE key=?').get(o.key) as any)?.status === 'new');
    let next = 0, stop = false;
    const worker = async () => {
      while (next < todo.length && !stop) {
        const o = todo[next++];
        const r = db.prepare('SELECT * FROM jobs WHERE key=?').get(o.key) as any;
        try {
          stats.llmCalls++;
          const s = await scoreJob(r, llm);
          putScore(db, o.key, cv, s); stats.scored++; o.score = s.score;
        } catch (e) {
          o.error = (e as Error).message; stats.errors.push(`${o.key}: ${o.error}`);
          if ((e as Error).name === 'BudgetError' || /budget cap/.test(o.error)) stop = true;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }
  return out;
}
