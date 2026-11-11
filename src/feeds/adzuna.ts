import type { Job } from '../types.js';
import { htmlToText } from '../adapters/text.js';
import type { PayRaw } from '../pay.js';
import { feedFetch } from './http.js';

export const ADZUNA_NEEDS = 'needs ADZUNA_APP_ID and ADZUNA_APP_KEY in .env';
export const ADZUNA_ATTRIBUTION = 'Source: Adzuna (adzuna.com)';

/** Adzuna search API (https://developer.adzuna.com/docs/search). Built from the public docs; not run against the live API (no keys on this machine).
 * Shape: results[] { id, title (may contain <strong> highlights), description (snippet), created (ISO), redirect_url, company.display_name, location.display_name,
 * salary_min, salary_max, salary_is_predicted ("0"|"1"), contract_type }. Predicted salaries are Adzuna estimates, not posted pay, so they are NOT mapped to payRaw. */
export function parseAdzuna(json: any): Job[] {
  const out: Job[] = [];
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    if (!r || r.id == null || !r.title) continue;
    const title = htmlToText(String(r.title));
    const loc = String(r.location?.display_name ?? '').trim();
    const remote = /\bremote\b/i.test(`${title} ${loc}`);
    const lo = Number(r.salary_min) || 0, hi = Number(r.salary_max) || 0;
    const predicted = String(r.salary_is_predicted ?? '0') === '1';
    const payRaw: PayRaw | null = !predicted && (lo || hi) ? { min: lo || null, max: hi || null, interval: 'year', currency: 'USD', noteText: '' } : null;   // Adzuna salaries are annual
    const posted = r.created && !isNaN(Date.parse(r.created)) ? new Date(r.created).toISOString() : null;
    out.push({
      source: 'adzuna',
      id: String(r.id),
      company: htmlToText(String(r.company?.display_name ?? '')),
      title,
      location: remote ? 'Remote' : loc,
      description: `${ADZUNA_ATTRIBUTION}\n${htmlToText(String(r.description ?? ''))}`,
      url: String(r.redirect_url ?? ''),
      remote: remote || undefined,
      payRaw,
      postedAt: posted, postedSource: posted ? 'published' : null,
    });
  }
  return out;
}

export async function fetchAdzuna(cfg: { what: string; where?: string; country?: string }): Promise<Job[]> {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) throw new Error(ADZUNA_NEEDS);
  const q = new URLSearchParams({ app_id: id, app_key: key, what: cfg.what, results_per_page: '50', sort_by: 'date', 'content-type': 'application/json' });
  if (cfg.where) q.set('where', cfg.where);
  const res = await feedFetch(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(cfg.country ?? 'us')}/search/1?${q}`);
  if (!res.ok) throw new Error(`adzuna: HTTP ${res.status}`);
  return parseAdzuna(await res.json());
}
