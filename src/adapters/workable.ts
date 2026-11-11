import type { Job } from '../types.js';
import { htmlToText } from './text.js';
import { politeFetch } from '../http.js';

/** Verified (real response, apply.workable.com robots.txt allows everything): the widget feed with ?details=true returns
 * {name, description, jobs: [{title, shortcode, url, application_url, published_on 'YYYY-MM-DD', created_at 'YYYY-MM-DD',
 * telecommuting: boolean, city, state, country, locations: [{country, countryCode, city, region, hidden}], description (HTML), ...}]}.
 * No structured salary field was observed, so payRaw is always null. Descriptions are included, so no detail calls are needed. */
export const workableBoardUrl = (slug: string) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;

const iso = (d: unknown): string | null => {
  if (typeof d !== 'string' || !d) return null;
  const t = new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

function workableLocation(j: any): string {
  const locs: any[] = Array.isArray(j.locations) ? j.locations.filter((l: any) => l && !l.hidden) : [];
  const parts = locs.length
    ? [...new Set(locs.map((l) => [l.city, l.region, l.country].filter(Boolean).join(', ')).filter(Boolean))]
    : [[j.city, j.state, j.country].filter(Boolean).join(', ')].filter(Boolean);
  if (j.telecommuting === true) parts.unshift('Remote');
  return parts.join(' | ');
}

export function parseWorkable(json: any, company: string): Job[] {
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.filter((j: any) => j && (j.shortcode || j.title)).map((j: any): Job => {
    const posted = iso(j.published_on) ?? iso(j.created_at);
    const remote = j.telecommuting === true;
    return {
      source: 'workable',
      id: String(j.shortcode ?? j.code ?? j.url),
      company,
      title: String(j.title ?? ''),
      location: workableLocation(j),
      description: htmlToText(String(j.description ?? '')),
      url: String(j.url ?? j.shortlink ?? (j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : '')),
      postedAt: posted,
      postedSource: posted ? (iso(j.published_on) ? 'published' : 'created') : null,
      workplaceRaw: remote ? 'remote' : null,   // telecommuting is a boolean; false does not prove onsite
      payRaw: null,
      remote: remote || undefined,
    };
  });
}

export async function fetchWorkable(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(workableBoardUrl(slug));
  if (!res.ok) throw new Error(`workable ${slug}: HTTP ${res.status}`);
  return parseWorkable(await res.json(), company);
}
