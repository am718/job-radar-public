import type { Job } from '../types.js';
import { htmlToText } from './text.js';
import { politeFetch } from '../http.js';
import { titleExcluded } from '../prefilter.js';

/** NOT LIVE-VERIFIED. https://api.smartrecruiters.com/robots.txt is "User-agent: * / Disallow: /" (only LinkedInBot may use /v1/companies/),
 * so by project rule we do not call this API. The parser follows SmartRecruiters' documented Posting API shape:
 * list {content: [{id, name, releasedDate, company:{identifier,name}, location:{city,region,country,remote,fullLocation}, ...}]} and detail
 * /postings/<id> {postingUrl, applyUrl, jobAd:{sections:{jobDescription:{text}, qualifications:{text}, ...}}}.
 * Flip SMARTRECRUITERS_API_ALLOWED only if the robots policy changes or SmartRecruiters grants permission. */
export const SMARTRECRUITERS_API_ALLOWED = false;
export const SMARTRECRUITERS_DETAIL_CAP = 60;
export const smartrecruitersBoardUrl = (slug: string) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`;
const detailUrl = (slug: string, id: string) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`;

export function parseSmartRecruitersDetail(d: any): { description: string; url: string | null } | null {
  if (!d || typeof d !== 'object') return null;
  const s = d.jobAd?.sections ?? {};
  const description = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => (s[k]?.text ? `${s[k].title ?? ''}\n${htmlToText(String(s[k].text))}`.trim() : ''))
    .filter(Boolean).join('\n');
  return { description, url: typeof d.postingUrl === 'string' ? d.postingUrl : null };
}

function srLocation(l: any): string {
  if (!l) return '';
  const base = l.fullLocation && typeof l.fullLocation === 'string' ? l.fullLocation : [l.city, l.region, String(l.country ?? '').toUpperCase()].filter(Boolean).join(', ');
  return l.remote === true && !/remote/i.test(base) ? ['Remote', base].filter(Boolean).join(' | ') : base;
}

export function parseSmartRecruiters(json: any, company: string, details: Record<string, ReturnType<typeof parseSmartRecruitersDetail>> = {}, slug = ''): Job[] {
  const list = Array.isArray(json?.content) ? json.content : [];
  return list.filter((p: any) => p && p.id).map((p: any): Job => {
    const id = String(p.id), d = details[id];
    const released = typeof p.releasedDate === 'string' && !Number.isNaN(new Date(p.releasedDate).getTime()) ? new Date(p.releasedDate).toISOString() : null;
    const l = p.location ?? {};
    const company0 = p.company?.identifier ?? slug;
    return {
      source: 'smartrecruiters',
      id,
      company,
      title: String(p.name ?? ''),
      location: srLocation(l),
      description: d?.description ?? '',
      url: d?.url ?? (company0 ? `https://jobs.smartrecruiters.com/${company0}/${id}` : ''),
      postedAt: released,
      postedSource: released ? 'published' : null,
      workplaceRaw: l.hybrid === true ? 'hybrid' : l.remote === true ? 'remote' : null,
      payRaw: null,
      remote: l.remote === true && l.hybrid !== true ? true : undefined,
    };
  });
}

export async function fetchSmartRecruiters(slug: string, company: string): Promise<Job[]> {
  if (!SMARTRECRUITERS_API_ALLOWED) throw new Error(`smartrecruiters ${slug}: HTTP 403 (api.smartrecruiters.com robots.txt disallows non-LinkedIn crawlers; adapter disabled)`);
  const res = await politeFetch(smartrecruitersBoardUrl(slug));
  if (!res.ok) throw new Error(`smartrecruiters ${slug}: HTTP ${res.status}`);
  const json = await res.json();
  const details: Record<string, ReturnType<typeof parseSmartRecruitersDetail>> = {};
  let calls = 0;
  for (const p of Array.isArray(json?.content) ? json.content : []) {
    if (calls >= SMARTRECRUITERS_DETAIL_CAP) break;
    if (!p?.id || titleExcluded(String(p.name ?? ''))) continue;
    calls++;
    try {
      const r = await politeFetch(detailUrl(slug, String(p.id)), { retries: 1 });
      if (r.ok) details[String(p.id)] = parseSmartRecruitersDetail(await r.json());
    } catch { /* keep the posting without a description */ }
  }
  return parseSmartRecruiters(json, company, details, slug);
}
