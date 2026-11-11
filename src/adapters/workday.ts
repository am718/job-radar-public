import type { Job } from '../types.js';
import { htmlToText } from './text.js';
import { USER_AGENT } from '../config.js';
import { titleExcluded } from '../prefilter.js';
import { robotsAllows } from '../apply/protection.js';

/** Workday application forms are never auto-filled (apply by hand). */
export const WORKDAY_APPLY_BY_HAND = true;

/** Slug format: `<tenant>|<wdN>|<site>`, e.g. `nvidia|wd5|NVIDIAExternalCareerSite`.
 * Robots: https://nvidia.wd5.myworkdayjobs.com/robots.txt has `User-agent: *` rules for specific site paths only (/talentcommunity/, /refreshFacet/ ...);
 * nothing disallows /wday/cxs, so the career site's own JSON is read (read-only; list POST + per-job GET).
 * Verified (real responses): POST .../wday/cxs/<t>/<site>/jobs -> {total, jobPostings:[{title, externalPath, locationsText, postedOn:'Posted 11 Days Ago', bulletFields:[reqId]}]}
 * (relative postedOn text is ignored). GET .../wday/cxs/<t>/<site>/job/<externalPath> -> {jobPostingInfo:{title, jobDescription (HTML), location, startDate 'YYYY-MM-DD',
 * jobReqId, externalUrl, timeType, remoteType?}}. startDate matched "Posted N Days Ago" exactly on the two postings checked, so it is used as the posted date. */
export function parseWorkdaySlug(slug: string): { tenant: string; wd: string; site: string } {
  const [tenant, wd, site] = String(slug).split('|');
  if (!tenant || !wd || !site) throw new Error(`workday ${slug}: slug must be <tenant>|<wdN>|<site>`);
  if (!/^[A-Za-z0-9_-]+$/.test(tenant) || !/^wd\d{1,3}$/.test(wd) || !/^[A-Za-z0-9_-]+$/.test(site)) throw new Error(`workday ${slug}: tenant/site may only contain letters, digits, - and _; wdN like wd5`);   // the slug becomes a hostname: nothing else may reach it
  return { tenant, wd, site };
}
const host = (s: { tenant: string; wd: string }) => `https://${s.tenant}.${s.wd}.myworkdayjobs.com`;
export const workdayBoardUrl = (slug: string) => { const s = parseWorkdaySlug(slug); return `${host(s)}/${s.site}`; };

const PAGE = 20, MAX_PAGES = 3, MAX_DETAILS = 60;
const isoOrNull = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** details: map externalPath -> parsed detail response (optional). */
export function parseWorkday(json: any, company: string, slug: string, details: Record<string, any> = {}): Job[] {
  let base: string;
  try { base = workdayBoardUrl(slug); } catch { return []; }
  const rows: any[] = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
  return rows.filter((j) => j && j.title && typeof j.externalPath === 'string').map((j): Job => {
    const d = details[j.externalPath]?.jobPostingInfo ?? null;
    const id = String(d?.jobReqId || /_([^_/]+)$/.exec(j.externalPath)?.[1] || j.externalPath.split('/').pop());
    const loc = String(d?.location || j.locationsText || '');
    const remote = /remote/i.test(loc) || /remote/i.test(String(d?.remoteType ?? ''));
    const location = remote && !/remote/i.test(loc) ? `${loc}, Remote` : loc;
    const posted = isoOrNull(d?.startDate);
    return {
      source: 'workday', id, company,
      title: String(d?.title || j.title),
      location,
      description: d?.jobDescription ? htmlToText(String(d.jobDescription)) : '',
      url: String(d?.externalUrl || `${base}${j.externalPath}`),
      remote: remote || undefined,
      postedAt: posted, postedSource: posted ? 'published' : null,
      workplaceRaw: d?.remoteType ? String(d.remoteType) : null,   // present only on some tenants
      payRaw: null,   // no structured salary field in Workday's public JSON
    };
  });
}

// --- polite POST/GET (politeFetch is GET-only): 1 request/second/host, named User-Agent, small retry ---
const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function polite(url: string, init: RequestInit = {}): Promise<Response> {
  const h = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const wait = (lastHit.get(h) ?? 0) + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(h, Date.now());
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) { lastErr = e; if (attempt < 2) await sleep(1000 * 2 ** attempt); }
  }
  throw new Error(`fetch failed for ${url}: ${(lastErr as Error)?.message}`);
}

export async function fetchWorkday(slug: string, company: string, o: { robots?: (url: string) => Promise<string | null> } = {}): Promise<Job[]> {
  const s = parseWorkdaySlug(slug);
  const api = `${host(s)}/wday/cxs/${s.tenant}/${s.site}`;
  // robots.txt is checked per tenant on every fetch (one GET), not assumed from the one tenant checked by hand
  const robotsTxt = await (o.robots ?? (async (u: string) => { try { const r = await polite(u, { headers: { Accept: 'text/plain' } }); return r.ok ? await r.text() : null; } catch { return null; } }))(`${host(s)}/robots.txt`);
  if (robotsTxt && !robotsAllows(robotsTxt, `/wday/cxs/${s.tenant}/${s.site}/jobs`)) throw new Error(`workday ${slug}: robots.txt disallows the job feed; skipped`);
  const postings: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await polite(`${api}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: '' }) });
    if (!res.ok) throw new Error(`workday ${slug}: HTTP ${res.status}`);
    const j: any = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(j?.jobPostings) ? j.jobPostings : [];
    postings.push(...rows);
    if (rows.length < PAGE) break;
  }
  const details: Record<string, any> = {};
  let calls = 0;
  for (const p of postings) {
    if (calls >= MAX_DETAILS) break;
    if (!p?.externalPath || !p.title || titleExcluded(String(p.title))) continue;
    calls++;
    try {
      const r = await polite(`${api}${p.externalPath}`);
      if (r.ok) details[p.externalPath] = await r.json();
    } catch { /* keep the posting without a description */ }
  }
  return parseWorkday({ jobPostings: postings }, company, slug, details);
}
