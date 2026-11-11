import type Database from 'better-sqlite3';
import type { Company, Job } from './types.js';
import { prefilter } from './prefilter.js';
import { locationTier } from './location.js';
import { loadConfig } from './userconfig.js';
import { upsertJob, getCachedScore, putScore } from './store.js';
import { resolvePay, applyPayRules } from './pay.js';
import { detectArrangement, hoursNote } from './arrangement.js';
import { postedInfo, etDate } from './fresh.js';
import { scoreJob, cacheVersion, type LlmFn } from './scoring/scorer.js';
import { DEFAULT_PROMPT } from './scoring/prompts.js';
import { buildDigest, STILL_OPEN_MIN, SHOW_MIN, type DigestRow, type ByHandEntry } from './digest.js';
import { siteStatus } from './apply/sites.js';
import { byHandFiles } from './apply/byfiles.js';

const listedPayRules = loadConfig().listedPayRequired;

export interface ScanStats { fetched: number; filtered: number; newJobs: number; scored: number; llmCalls: number; errors: string[] }

/** Classify, store new jobs, score only new+unscored+passing jobs. */
export const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export async function processJobs(db: Database.Database, jobs: Job[], llm: LlmFn | null, stats: ScanStats, pv = DEFAULT_PROMPT, profileSummary?: string, opts: { freshOnly?: boolean; asOf?: string; seenAt?: string } = {}) {
  const cv = cacheVersion(pv, profileSummary);
  const asOf = opts.asOf ?? todayET();
  // A company with no stored jobs is being scanned for the FIRST time: everything it lists already existed, so none of it is "new" (its first_seen is not a posting date).
  const knownCompanies = new Set((db.prepare('SELECT DISTINCT company FROM jobs').all() as { company: string }[]).map((r) => r.company));
  for (const j of jobs) {
    stats.fetched++;
    const pf = prefilter(j);
    const tier = locationTier(j);
    const info = resolvePay(j), dec = applyPayRules(info);
    if (dec.drop) { info.reason = dec.rule; info.display = `below floor (${dec.rule})`; }
    // order: title/experience filter -> location -> pay floor -> tiers in listedPayRequired need listed pay
    const reason = !pf.keep ? pf.reason! : tier == null ? 'location dropped' : dec.drop ? 'pay below floor' : dec.flag === 'pay unlisted' ? (listedPayRules.find((r) => r.tier === tier)?.reason ?? null) : null;
    if (reason) stats.filtered++;
    const arr = detectArrangement(j), hours = hoursNote(j.description, j.title);   // code only: no LLM, never a drop
    if (upsertJob(db, j, tier, reason, { pay: { info, flag: dec.flag }, arr, hours, baseline: !knownCompanies.has(j.company), seenAt: opts.seenAt }) === 'new') stats.newJobs++;
  }
  let todo = db.prepare(`SELECT * FROM jobs WHERE filter_reason IS NULL AND status='new' AND key NOT IN (SELECT key FROM scores WHERE prompt_version=?)`).all(cv) as any[];
  if (opts.freshOnly) todo = todo.filter((r) => { const p = postedInfo(r, asOf); return p.fresh || p.newToday; });   // --fresh-only: score only jobs posted in the last 7 days or NEW today
  if (!llm && todo.length) { stats.errors.push('no LLM configured; skipping scoring'); return; }
  let next = 0, stop = false;
  const worker = async () => {
    while (next < todo.length && !stop) {
      const r = todo[next++];
      if (getCachedScore(db, r.key, cv)) continue;
      try {
        stats.llmCalls++;
        putScore(db, r.key, cv, await scoreJob(r, llm!, { promptVersion: pv, profileSummary }));
        stats.scored++;
      } catch (e) {
        stats.errors.push(`${r.key}: ${(e as Error).message}`);
        if ((e as Error).name === 'BudgetError' || /budget cap/.test((e as Error).message)) stop = true;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

const toRow = (r: any, asOf: string): DigestRow => ({ key: r.key, company: r.company, title: r.title, location: r.location, pay: r.pay, url: r.url, tier: r.tier, payDisplay: r.pay_display ?? 'unlisted', payFlag: (r.pay_flag ?? 'pay unlisted') as any, payStatus: r.pay_status ?? 'unlisted', payRaw: r.pay_raw ?? '', arrangement: (r.arrangement ?? 'unknown') as any, officeDays: r.office_days ?? null, hoursNote: r.hours_note ?? '', posted: postedInfo(r, asOf), score: JSON.parse(r.sj) });

/** Jobs scored but not yet shown in a digest. */
export function pendingDigestRows(db: Database.Database, pv = DEFAULT_PROMPT, profileSummary?: string, asOf = todayET()): DigestRow[] {
  const cv = cacheVersion(pv, profileSummary);
  const rows = db.prepare(`SELECT j.*, s.json AS sj FROM jobs j JOIN scores s ON s.key=j.key AND s.prompt_version=? WHERE j.status='new' AND j.filter_reason IS NULL`).all(cv) as any[];
  return rows.map((r) => toRow(r, asOf));
}
/** All scored jobs already included in the digest for `date` (so re-running a scan the same day never shrinks the file). */
export function digestRowsFor(db: Database.Database, date: string, pv = DEFAULT_PROMPT, profileSummary?: string, asOf = date): DigestRow[] {
  const cv = cacheVersion(pv, profileSummary);
  const rows = db.prepare(`SELECT j.*, s.json AS sj FROM jobs j JOIN scores s ON s.key=j.key AND s.prompt_version=? WHERE j.digest_date=? AND j.filter_reason IS NULL`).all(cv, date) as any[];
  return rows.map((r) => toRow(r, asOf));
}
/** Scored 60+, not marked applied/skip, shown in an EARLIER digest, and still on the company's board (present in that company's latest successful fetch). Kept until marked. */
export function stillOpenRows(db: Database.Database, date: string, pv = DEFAULT_PROMPT, profileSummary?: string, asOf = date): DigestRow[] {
  const cv = cacheVersion(pv, profileSummary);
  const rows = db.prepare(`SELECT j.*, s.json AS sj FROM jobs j JOIN scores s ON s.key=j.key AND s.prompt_version=? JOIN company_fetch f ON f.company=j.company AND f.seen_at=j.last_seen
    WHERE j.filter_reason IS NULL AND j.status NOT IN ('applied','skip') AND j.digest_date IS NOT NULL AND j.digest_date<?`).all(cv, date) as any[];
  return rows.map((r) => toRow(r, asOf)).filter((r) => r.score.score >= STILL_OPEN_MIN)
    .sort((a, b) => b.score.score - a.score.score || (a.posted?.daysAgo ?? 1e9) - (b.posted?.daysAgo ?? 1e9));
}
/** Digest jobs (this day's 40+ and the still-open 60+) whose company is bot protected, with whatever note/letter files already exist. */
export function byHandEntries(db: Database.Database, rows: DigestRow[], stillOpen: DigestRow[], dir?: string): ByHandEntry[] {
  const seen = new Set<string>(), out: ByHandEntry[] = [];
  for (const r of [...rows.filter((x) => x.score.score >= SHOW_MIN), ...stillOpen].sort((a, b) => b.score.score - a.score.score)) {
    if (seen.has(r.key)) continue; seen.add(r.key);
    const st = siteStatus(db, r.company); if (st.status !== 'protected') continue;
    if (['applied', 'skip'].includes((db.prepare('SELECT status FROM jobs WHERE key=?').get(r.key) as any)?.status)) continue;
    const f = byHandFiles(r.key, dir);
    out.push({ row: r, vendor: st.vendor, reason: st.reason, note: f.note, letterPdf: f.letterPdf });
  }
  return out;
}
export { buildDigest };
