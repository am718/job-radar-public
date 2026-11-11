import type { Job } from '../types.js';
import { parseGreenhouse } from '../adapters/greenhouse.js';
import { parseLever } from '../adapters/lever.js';
import { parseAshby, ashbyUrl } from '../adapters/ashby.js';
import { jsonHeaders, type FetchFn } from './net.js';

export type AtsRefSource = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters';
export interface AtsRef { source: AtsRefSource; slug: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recognises a single-job URL of a supported ATS. `ghHostSlugs` maps a company careers host to its Greenhouse slug so `?gh_jid=` links on company sites can be resolved; without it they return null. */
export function parseAtsUrl(raw: string, ghHostSlugs: Record<string, string> = {}): AtsRef | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase(), seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    if (seg.length >= 3 && seg[1] === 'jobs' && /^\d+$/.test(seg[2])) return { source: 'greenhouse', slug: seg[0], id: seg[2] };
    const slug = u.searchParams.get('for'), id = u.searchParams.get('token') ?? u.searchParams.get('gh_jid');
    if (seg[0] === 'embed' && slug && id && /^\d+$/.test(id)) return { source: 'greenhouse', slug, id };
    return null;
  }
  const jid = u.searchParams.get('gh_jid');
  if (jid && /^\d+$/.test(jid)) { const slug = ghHostSlugs[host.replace(/^www\./, '')] ?? ghHostSlugs[host]; return slug ? { source: 'greenhouse', slug, id: jid } : null; }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && seg.length >= 2 && UUID.test(seg[1])) return { source: 'lever', slug: seg[0], id: seg[1].toLowerCase() };
  if (host === 'jobs.ashbyhq.com' && seg.length >= 2 && UUID.test(seg[1])) return { source: 'ashby', slug: seg[0], id: seg[1].toLowerCase() };
  if (host === 'apply.workable.com' && seg.length >= 3 && seg[1] === 'j' && /^[0-9a-z]+$/i.test(seg[2])) return { source: 'workable', slug: seg[0], id: seg[2] };
  if (host === 'jobs.smartrecruiters.com' && seg.length >= 2) { const m = /^(\d+)/.exec(seg[1]); if (m) return { source: 'smartrecruiters', slug: seg[0], id: m[1] }; }
  return null;
}

const pretty = (slug: string) => slug.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Fetches ONE job from the ATS's public JSON API. Returns null for ATSs without a single-job path here, or when the job is gone (caller falls back to the page path). Throws on network error. */
export async function fetchAtsJob(ref: AtsRef, fetch: FetchFn): Promise<Job | null> {
  const get = async (url: string) => { const r = await fetch(url, { headers: jsonHeaders() }); if (!r.ok) return null; try { return await r.json(); } catch { return null; } };
  if (ref.source === 'greenhouse') {
    const j: any = await get(`https://boards-api.greenhouse.io/v1/boards/${ref.slug}/jobs/${ref.id}?pay_transparency=true`);
    if (!j || j.id == null) return null;
    return parseGreenhouse({ jobs: [j] }, String(j.company_name ?? pretty(ref.slug)))[0] ?? null;
  }
  if (ref.source === 'lever') {
    const j: any = await get(`https://api.lever.co/v0/postings/${ref.slug}/${ref.id}`);
    if (!j || !j.id) return null;
    return parseLever([j], pretty(ref.slug))[0] ?? null;
  }
  if (ref.source === 'ashby') {
    const board: any = await get(ashbyUrl(ref.slug));
    const jobs = parseAshby(board, pretty(ref.slug));
    return jobs.find((j) => j.id.toLowerCase() === ref.id) ?? null;
  }
  return null;
}
