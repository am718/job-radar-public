import type { Job } from '../types.js';
import { htmlToText } from './text.js';
import { politeFetch } from '../http.js';
import { intervalFrom, type PayRaw } from '../pay.js';

/** Verified (real responses; robots.txt on <slug>.recruitee.com only disallows /v/): GET https://<slug>.recruitee.com/api/offers/ returns
 * {offers: [{id, title, slug, status, description (HTML), requirements (HTML), city, state_code, country, country_code, location,
 * remote, hybrid, on_site (booleans), created_at / published_at 'YYYY-MM-DD HH:MM:SS UTC', updated_at, careers_url, careers_apply_url,
 * salary: {min, max, period: 'year', currency} (values are strings, all null when unset), locations: [...]}]}.
 * Descriptions are included, so no detail calls. A missing board returns 404 {"error":"Not Found"}. */
export const recruiteeBoardUrl = (slug: string) => `https://${slug}.recruitee.com/api/offers/`;

const iso = (s: unknown): string | null => {
  if (typeof s !== 'string' || !s) return null;
  const t = new Date(s.replace(/ UTC$/, 'Z').replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const num = (x: unknown): number | null => { const n = typeof x === 'number' ? x : parseFloat(String(x ?? '')); return Number.isFinite(n) ? n : null; };

export function recruiteePay(o: any): PayRaw | null {
  const s = o?.salary;
  if (!s) return null;
  const min = num(s.min), max = num(s.max);
  if (min == null && max == null) return null;
  return { min, max, interval: intervalFrom(s.period), currency: s.currency ?? null, noteText: '' };
}

function recruiteeLocation(o: any): string {
  const locs: any[] = Array.isArray(o.locations) ? o.locations : [];
  const parts = locs.length
    ? locs.map((l) => [l.city, l.state_code ?? l.state, l.country].filter(Boolean).join(', '))
    : [[o.city, o.state_code, o.country].filter(Boolean).join(', ')];
  const out = [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
  if (o.remote === true) out.unshift('Remote');
  return out.join(' | ');
}

export function parseRecruitee(json: any, company: string): Job[] {
  const offers = Array.isArray(json?.offers) ? json.offers : [];
  return offers.filter((o: any) => o && o.id != null && (o.status == null || o.status === 'published')).map((o: any): Job => {
    const posted = iso(o.published_at) ?? iso(o.created_at);
    const workplace = o.hybrid === true ? 'hybrid' : o.remote === true ? 'remote' : o.on_site === true ? 'onsite' : null;
    return {
      source: 'recruitee',
      id: String(o.id),
      company,
      title: String(o.title ?? ''),
      location: recruiteeLocation(o),
      description: [o.description, o.requirements].filter(Boolean).map((h: string) => htmlToText(String(h))).join('\n'),
      url: String(o.careers_url ?? o.careers_apply_url ?? ''),
      postedAt: posted,
      postedSource: posted ? (iso(o.published_at) ? 'published' : 'created') : null,
      updatedRaw: iso(o.updated_at),
      workplaceRaw: workplace,
      payRaw: recruiteePay(o),
      remote: (o.remote === true && o.hybrid !== true) || undefined,
    };
  });
}

export async function fetchRecruitee(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(recruiteeBoardUrl(slug));
  if (!res.ok) throw new Error(`recruitee ${slug}: HTTP ${res.status}`);
  return parseRecruitee(await res.json(), company);
}
