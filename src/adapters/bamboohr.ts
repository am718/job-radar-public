import type { Job } from '../types.js';
import { htmlToText } from './text.js';
import { politeFetch } from '../http.js';
import { titleExcluded } from '../prefilter.js';

/** Verified (real responses, canopy/lendio boards): GET /careers/list -> {meta:{totalCount}, result:[{id, jobOpeningName, departmentLabel,
 * employmentStatusLabel, location:{city,state}, isRemote, locationType}]}. The list has NO description and NO date.
 * GET /careers/<id>/detail -> {result:{jobOpening:{jobOpeningShareUrl, description (HTML), datePosted 'YYYY-MM-DD', compensation (string|null),
 * location:{city,state,addressCountry}, isRemote?, locationType}}}. datePosted is the only date field; it is on the detail only. */
export const bamboohrBoardUrl = (slug: string) => `https://${slug}.bamboohr.com/careers/list`;
const detailUrl = (slug: string, id: string) => `https://${slug}.bamboohr.com/careers/${id}/detail`;
const MAX_DETAILS = 60;

const isoDate = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/** details: map of posting id -> parsed /detail response (optional; missing entries just give an empty description and null postedAt). */
export function parseBamboohr(json: any, company: string, slug: string, details: Record<string, any> = {}): Job[] {
  const rows: any[] = Array.isArray(json?.result) ? json.result : [];
  return rows.filter((j) => j && j.id != null && j.jobOpeningName).map((j): Job => {
    const id = String(j.id);
    const d = details[id]?.result?.jobOpening ?? null;
    const loc = d?.location ?? j.location ?? {};
    const remote = j.isRemote === true || d?.isRemote === true;
    const parts = [loc.city, loc.state, d?.location?.addressCountry].filter((x) => typeof x === 'string' && x.trim()) as string[];
    const location = [...new Set(parts), ...(remote ? ['Remote'] : [])].join(', ');
    const desc = d?.description ? htmlToText(String(d.description)) : '';
    const comp = typeof d?.compensation === 'string' && d.compensation.trim() ? `Compensation: ${htmlToText(d.compensation)}` : '';
    const posted = isoDate(d?.datePosted);
    const lt = String(d?.locationType ?? j.locationType ?? '');
    return {
      source: 'bamboohr', id, company,
      title: String(j.jobOpeningName),
      location,
      description: [desc, comp].filter(Boolean).join('\n'),
      url: String(d?.jobOpeningShareUrl || `https://${slug}.bamboohr.com/careers/${id}`),
      remote: remote || undefined,
      postedAt: posted, postedSource: posted ? 'published' : null,
      workplaceRaw: remote ? 'remote' : lt === '0' ? 'onsite' : null,   // locationType: only 0 (onsite) and 2 were observed; other codes are not interpreted
      payRaw: null,   // compensation is free text (null in every response seen), no structured numbers
    };
  });
}

export async function fetchBamboohr(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(bamboohrBoardUrl(slug));
  if (!res.ok) throw new Error(`bamboohr ${slug}: HTTP ${res.status}`);
  const list: any = await res.json().catch(() => null);   // an unknown tenant 302s to bamboohr.com (HTML) - treated as not found below
  if (!list || !Array.isArray(list.result)) throw new Error(`bamboohr ${slug}: HTTP 404 (unknown tenant: redirected to bamboohr.com, not a job list)`);
  const details: Record<string, any> = {};
  let calls = 0;
  for (const j of list.result) {
    if (calls >= MAX_DETAILS) break;
    if (!j?.id || !j.jobOpeningName || titleExcluded(String(j.jobOpeningName))) continue;
    calls++;
    try {
      const r = await politeFetch(detailUrl(slug, String(j.id)));
      if (r.ok) details[String(j.id)] = await r.json();
    } catch { /* keep the posting without a description */ }
  }
  return parseBamboohr(list, company, slug, details);
}
