import type Database from 'better-sqlite3';
import { USER_AGENT } from '../config.js';
import { classify, robotsAllows, type Protection } from './protection.js';
import { applyUrl, canonicalGreenhouseUrl } from './ats.js';
import { recordSite, siteStatus, type SiteStatus } from './sites.js';
import type { Ats } from '../types.js';

export interface Fetched { status: number; headers: Record<string, string>; body: string; location?: string }
/** The ONLY network call preflight makes: a plain GET (never POST), with our normal user agent, redirects followed by hand so robots.txt is checked on every host. */
export type GetFn = (url: string) => Promise<Fetched>;

export const realGet: GetFn = async (url) => {
  const res = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(15000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const sc = (res.headers as any).getSetCookie?.() as string[] | undefined; if (sc?.length) headers['set-cookie'] = sc.join(', ');
  const body = res.status >= 300 && res.status < 400 ? '' : (await res.text()).slice(0, 300_000);
  return { status: res.status, headers, body, location: res.headers.get('location') ?? undefined };
};

const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Rate limit: at least `gap` ms between two requests to one host. */
async function polite(url: string, get: GetFn, gap: number): Promise<Fetched> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  return get(url);
}

export interface PreflightResult extends Protection { status: SiteStatus; checkedUrl: string; finalUrl: string | null; robots: 'allowed' | 'disallowed' | 'n/a' }

/** Read-only look at one apply URL. Result: ok / protected / unknown (unknown = could not tell: network error, robots disallow, odd status; it is NOT treated as protected). */
export async function preflightUrl(url: string, ats: string, o: { get?: GetFn; gapMs?: number; robotsCache?: Map<string, string> } = {}): Promise<PreflightResult> {
  const get = o.get ?? realGet, gap = o.gapMs ?? 1000, robots = o.robotsCache ?? new Map<string, string>();
  let cur = url, last: Fetched | null = null;
  try {
    for (let hop = 0; hop < 5; hop++) {
      const u = new URL(cur);
      if (!robots.has(u.origin)) {
        let txt = '';
        try { const r = await polite(`${u.origin}/robots.txt`, get, gap); txt = r.status === 200 ? r.body : ''; } catch { txt = ''; }
        robots.set(u.origin, txt);
      }
      if (!robotsAllows(robots.get(u.origin)!, u.pathname + u.search)) return { protected: false, vendor: null, status: 'unknown', reason: `robots.txt of ${u.host} disallows this path; not fetched`, checkedUrl: url, finalUrl: cur, robots: 'disallowed' };
      last = await polite(cur, get, gap);
      const c = classify({ status: last.status, headers: last.headers, body: last.body, requestedUrl: url, finalUrl: cur, ats });
      if (c.protected) return { ...c, status: 'protected', checkedUrl: url, finalUrl: cur, robots: 'allowed' };
      if (last.status >= 300 && last.status < 400 && last.location) { cur = new URL(last.location, cur).toString(); continue; }
      break;
    }
    if (!last) return { protected: false, vendor: null, status: 'unknown', reason: 'no response', checkedUrl: url, finalUrl: null, robots: 'allowed' };
    const final = classify({ status: last.status, headers: last.headers, body: last.body, requestedUrl: url, finalUrl: cur, ats });
    if (final.protected) return { ...final, status: 'protected', checkedUrl: url, finalUrl: cur, robots: 'allowed' };
    if (last.status >= 300 && last.status < 400) return { protected: false, vendor: null, status: 'unknown', reason: `too many redirects (last HTTP ${last.status})`, checkedUrl: url, finalUrl: cur, robots: 'allowed' };
    if (last.status >= 200 && last.status < 300) return { protected: false, vendor: null, status: 'ok', reason: `HTTP ${last.status}, no bot-protection signal`, checkedUrl: url, finalUrl: cur, robots: 'allowed' };
    return { protected: false, vendor: null, status: 'unknown', reason: `HTTP ${last.status}, no recognised protection signal (closed posting or transient)`, checkedUrl: url, finalUrl: cur, robots: 'allowed' };
  } catch (e) {
    return { protected: false, vendor: null, status: 'unknown', reason: `request failed: ${(e as Error).message.split('\n')[0].slice(0, 120)}`, checkedUrl: url, finalUrl: null, robots: 'allowed' };
  }
}

export const preflightUrlFor = (j: { source: string; id: string; url: string }, slugOf: (company: string) => string | null, company: string) =>
  j.source === 'greenhouse' ? canonicalGreenhouseUrl(j.url, String(j.id), slugOf(company)) : applyUrl(j.source as Ats, j.url);

/** One preflight per company per run. Skips companies with a fresh status unless force. Writes to apply_sites. An 'unknown' result never overwrites an older definite status. */
export async function preflightCompanies(db: Database.Database, jobs: { company: string; source: string; id: string; url: string }[], o: { get?: GetFn; gapMs?: number; force?: boolean; slugOf?: (c: string) => string | null; log?: (s: string) => void; now?: Date } = {}): Promise<{ company: string; ats: string; result: PreflightResult | null; cached: boolean }[]> {
  const seen = new Set<string>(), out: Awaited<ReturnType<typeof preflightCompanies>> = [];
  const robots = new Map<string, string>();
  for (const j of jobs) {
    if (seen.has(j.company.toLowerCase())) continue;
    seen.add(j.company.toLowerCase());
    const st = siteStatus(db, j.company, o.now);
    if (!o.force && st.fresh) { out.push({ company: j.company, ats: j.source, result: null, cached: true }); continue; }
    const url = preflightUrlFor(j, o.slugOf ?? (() => null), j.company);
    const r = await preflightUrl(url, j.source, { get: o.get, gapMs: o.gapMs, robotsCache: robots });
    o.log?.(`preflight ${j.company}: ${r.status}${r.vendor ? ` (${r.vendor})` : ''}`);
    const prev = siteStatus(db, j.company, o.now);
    const manual = prev.fresh && prev.source === 'manual';
    if (!manual && !(r.status === 'unknown' && prev.status !== 'unknown')) recordSite(db, { company: j.company, ats: j.source, status: r.status, vendor: r.vendor, reason: r.reason, source: 'preflight', checked_at: (o.now ?? new Date()).toISOString() });
    out.push({ company: j.company, ats: j.source, result: r, cached: false });
  }
  return out;
}
