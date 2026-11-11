import type Database from 'better-sqlite3';
import type { Job } from '../types.js';
import type { LlmFn } from '../scoring/scorer.js';
import type { ScanStats } from '../pipeline.js';
import { urlRefusal } from './hosts.js';
import { parseAtsUrl, fetchAtsJob } from './atsurl.js';
import { extractJobPosting, canonicalUrl } from './extract.js';
import { htmlHeaders, type FetchFn } from './net.js';
import { storeAndScore } from './store.js';

export interface AddDeps { fetch: FetchFn; llm: LlmFn | null; ghHostSlugs?: Record<string, string> }
export interface AddResult {
  ok: boolean;
  /** jobs.key, e.g. "greenhouse:123" or "link:ab12..." */
  key?: string;
  /** new = stored now; updated = this exact job was already stored (refreshed, no second row); dup = same company/title/location stored under another key; refused = host/URL not allowed, nothing fetched; failed = fetch/parse problem */
  status: 'new' | 'updated' | 'dup' | 'refused' | 'failed';
  reason?: string;
  score?: number;
  title?: string; company?: string;
}

/** Fetches one HTML page, following at most 5 redirects while checking EVERY hop (never requests a forbidden/private host). */
export async function fetchHtmlPage(url: string, fetch: FetchFn): Promise<{ html: string; url: string }> {
  let cur = url;
  for (let hop = 0; hop <= 5; hop++) {
    const bad = urlRefusal(cur);
    if (bad) throw Object.assign(new Error(bad.reason), { refused: true });
    const res = await fetch(cur, { method: 'GET', headers: htmlHeaders(), redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) { try { res.body?.cancel(); } catch { /* ignore */ } cur = new URL(loc, cur).toString(); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { html: (await res.text()).slice(0, 2_000_000), url: cur };
  }
  throw new Error('too many redirects');
}

export async function addJobFromUrl(db: Database.Database, rawUrl: string, deps: AddDeps): Promise<AddResult> {
  const url = rawUrl.trim();
  const bad = urlRefusal(url);
  if (bad) return { ok: false, status: 'refused', reason: bad.reason };
  let job: Job | null = null;
  try {
    const ref = parseAtsUrl(url, deps.ghHostSlugs);
    if (ref) { try { job = await fetchAtsJob(ref, deps.fetch); } catch { job = null; } }   // API trouble: fall back to the page
    if (!job) {
      const page = await fetchHtmlPage(canonicalUrl(url), deps.fetch);
      job = extractJobPosting(page.html, page.url);
      if (!job.title) return { ok: false, status: 'failed', reason: 'no job title found on that page' };
    }
  } catch (e) {
    const err = e as Error & { refused?: boolean };
    return err.refused ? { ok: false, status: 'refused', reason: err.message } : { ok: false, status: 'failed', reason: `fetch failed: ${err.message}` };
  }
  const stats: ScanStats = { fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] };
  const [o] = await storeAndScore(db, [job], deps.llm, stats);
  const res: AddResult = { ok: true, key: o.key, status: o.status, title: job.title, company: job.company };
  if (o.status === 'dup') res.reason = 'same company, title and location already stored under another source';
  else if (o.filterReason) res.reason = `stored but filtered out: ${o.filterReason}`;
  if (o.score != null) res.score = o.score;
  if (o.error) res.reason = `stored; scoring failed: ${o.error}`;
  else if (!deps.llm && !o.filterReason && o.score == null && o.status !== 'dup') res.reason = 'stored; not scored (no LLM)';
  return res;
}
