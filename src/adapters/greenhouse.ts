import type { Job } from '../types.js';
import { htmlToText, decodeEntities } from './text.js';
import { politeFetch } from '../http.js';
import { ANNUALIZE, intervalFrom, type PayRaw } from '../pay.js';

export const greenhouseUrl = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true&pay_transparency=true`;

const ghText = (c: string) => htmlToText(!c.includes('<') && c.includes('&lt;') ? decodeEntities(c) : c);

/** Verified field (real responses, only when ?pay_transparency=true): pay_input_ranges: [{min_cents, max_cents, currency_type, title, blurb}].
 * Several ranges can exist per job (regions); prefer ranges titled for New York, otherwise take the union of USD ranges. */
export function greenhousePay(j: any): PayRaw | null {
  const rs: any[] = (j.pay_input_ranges ?? []).filter((r: any) => r && (r.min_cents != null || r.max_cents != null));
  if (!rs.length) return null;
  const usdRs = rs.filter((r) => String(r.currency_type ?? '').toUpperCase() === 'USD');
  const pool = usdRs.length ? usdRs : rs;
  const nyc = pool.filter((r) => /new york|nyc/i.test(String(r.title ?? '')));
  const use = nyc.length ? nyc : pool;
  const interval = use.some((r) => /hour/i.test(String(r.title ?? ''))) ? 'hour' : 'year';   // only annual titles were observed; hourly is inferred from the title
  const mins = use.map((r) => r.min_cents).filter((x: any) => x != null), maxs = use.map((r) => r.max_cents).filter((x: any) => x != null);
  return {
    min: mins.length ? Math.min(...mins) / 100 : null, max: maxs.length ? Math.max(...maxs) / 100 : null,
    interval: interval as PayRaw['interval'], currency: String(use[0].currency_type ?? '') || null,
    noteText: use.map((r) => `${r.title ?? ''} ${htmlToText(String(r.blurb ?? ''))}`).join(' '),
  };
}

/** Greenhouse has no standard work-arrangement field. Some companies expose a custom metadata field; verified names/values in real responses:
 * "Workplace Type" (Remote | Hybrid | Onsite) and "Location Type" (On-Site | Remote | Hybrid (Travel-Required)). Other custom fields
 * (e.g. "Working Model Eligibility": multi-valued eligibility) are deliberately NOT used. Everything else falls back to text. */
export function greenhouseWorkplace(j: any): string | null {
  for (const m of j.metadata ?? []) {
    if (/^(workplace type|location type)$/i.test(String(m?.name ?? '').trim()) && m.value != null) {
      const v = Array.isArray(m.value) ? m.value[0] : m.value;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Verified in real responses (8,699 jobs): first_published exists on every job and is a real first-publication time; updated_at changes on edits (55% of jobs show an update in the last 7 days vs 9% first published, and whole boards share one bulk timestamp), so it is NOT a posting date. */
export const isoOrNull = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export function parseGreenhouse(json: any, company: string): Job[] {
  return (json?.jobs ?? []).map((j: any): Job => ({
    source: 'greenhouse',
    id: String(j.id),
    company,
    title: String(j.title ?? ''),
    location: String(j.location?.name ?? ''),
    // Greenhouse returns HTML that is itself entity-escaped
    description: ghText(String(j.content ?? '')),
    url: String(j.absolute_url ?? ''),
    payRaw: greenhousePay(j),
    postedAt: isoOrNull(j.first_published), postedSource: j.first_published ? 'published' : null, updatedRaw: j.updated_at ?? null,
    workplaceRaw: greenhouseWorkplace(j),
  }));
}
export async function fetchGreenhouse(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(greenhouseUrl(slug));
  if (!res.ok) throw new Error(`greenhouse ${slug}: HTTP ${res.status}`);
  return parseGreenhouse(await res.json(), company);
}
