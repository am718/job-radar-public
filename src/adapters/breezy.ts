import type { Job } from '../types.js';
import { htmlToText } from './text.js';
import { politeFetch } from '../http.js';
import { titleExcluded } from '../prefilter.js';
import { intervalFrom, type PayRaw } from '../pay.js';

/** Verified (real responses; robots.txt on <slug>.breezy.hr disallows only static asset dirs): GET https://<slug>.breezy.hr/json returns an ARRAY of
 * {id, friendly_id, name, url, published_date ISO, type, department, salary (display string), company, location: {city, state:{id,name}, country:{id,name},
 * is_remote, name, remote_details?: {value: 'remote'|..., label}}, locations: [...]}. NO description in the list.
 * The posting page (url) embeds a schema.org JobPosting JSON-LD block with the description (HTML) and, when set, baseSalary {currency, value:{unitText, minValue, maxValue}}.
 * We read that block for postings whose title passes the prefilter (max 60 per board). */
export const breezyBoardUrl = (slug: string) => `https://${slug}.breezy.hr/json`;
export const BREEZY_DETAIL_CAP = 60;

export interface BreezyDetail { description: string; payRaw: PayRaw | null }

/** Pure: extract description + structured salary from a posting page's JobPosting JSON-LD. */
export function parseBreezyDetail(html: string): BreezyDetail | null {
  for (const m of String(html ?? '').matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const ld = JSON.parse(m[1]);
      if (ld?.['@type'] !== 'JobPosting') continue;
      const v = ld.baseSalary?.value;
      const min = typeof v?.minValue === 'number' ? v.minValue : null, max = typeof v?.maxValue === 'number' ? v.maxValue : null;
      return {
        description: htmlToText(String(ld.description ?? '')),
        payRaw: min != null || max != null ? { min, max, interval: intervalFrom(v?.unitText), currency: ld.baseSalary?.currency ?? null, noteText: '' } : null,
      };
    } catch { /* ignore malformed block */ }
  }
  return null;
}

function breezyLocation(j: any): string {
  const locs: any[] = Array.isArray(j.locations) && j.locations.length ? j.locations : j.location ? [j.location] : [];
  const parts = locs.map((l) => [l.city, l.state?.id ?? l.state?.name, l.country?.name].filter(Boolean).join(', ')).filter(Boolean);
  const out = [...new Set(parts)];
  if (j.location?.is_remote === true || locs.some((l) => l.is_remote === true)) out.unshift('Remote');
  return out.join(' | ');
}

export function parseBreezy(json: any, company: string, details: Record<string, BreezyDetail | null | undefined> = {}): Job[] {
  return (Array.isArray(json) ? json : []).filter((j: any) => j && j.id).map((j: any): Job => {
    const id = String(j.id), d = details[id];
    const published = typeof j.published_date === 'string' && !Number.isNaN(new Date(j.published_date).getTime()) ? new Date(j.published_date).toISOString() : null;
    const rd = j.location?.remote_details?.value;
    const isRemote = j.location?.is_remote === true || (Array.isArray(j.locations) && j.locations.some((l: any) => l?.is_remote === true));
    return {
      source: 'breezy',
      id,
      company,
      title: String(j.name ?? ''),
      location: breezyLocation(j),
      description: d?.description ?? '',
      url: String(j.url ?? ''),
      postedAt: published,
      postedSource: published ? 'published' : null,
      workplaceRaw: typeof rd === 'string' && rd ? rd : null,   // verified value: 'remote' (only on boards with multi-location support)
      payRaw: d?.payRaw ?? null,
      remote: isRemote || undefined,
    };
  });
}

export async function fetchBreezy(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(breezyBoardUrl(slug));
  if (!res.ok) throw new Error(`breezy ${slug}: HTTP ${res.status}`);
  const json = await res.json();
  const list: any[] = Array.isArray(json) ? json : [];
  const details: Record<string, BreezyDetail | null> = {};
  let calls = 0;
  for (const j of list) {
    if (calls >= BREEZY_DETAIL_CAP) break;
    if (!j?.id || !j.url || titleExcluded(String(j.name ?? ''))) continue;
    calls++;
    try {
      const r = await politeFetch(String(j.url), { retries: 1 });
      if (r.ok) details[String(j.id)] = parseBreezyDetail(await r.text());
    } catch { /* keep the posting without a description */ }
  }
  return parseBreezy(list, company, details);
}
