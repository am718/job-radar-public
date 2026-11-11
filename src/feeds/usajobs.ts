import type { Job } from '../types.js';
import { htmlToText } from '../adapters/text.js';
import { intervalFrom, type PayRaw } from '../pay.js';
import { feedFetch } from './http.js';

export const USAJOBS_NEEDS = 'needs USAJOBS_API_KEY and USAJOBS_EMAIL in .env';

const asArr = (v: any): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** USAJobs Search API (https://developer.usajobs.gov/api-reference/get-api-search). Built from the public docs; not run against the live API (no key on this machine).
 * Shape: SearchResult.SearchResultItems[].MatchedObjectDescriptor { PositionTitle, PositionURI, OrganizationName, PositionLocationDisplay, PositionRemuneration[{MinimumRange, MaximumRange, RateIntervalCode, Description}],
 * PublicationStartDate, QualificationSummary, UserArea.Details { JobSummary, MajorDuties[], Requirements, Education, RemoteIndicator } }. */
export function parseUsaJobs(json: any): Job[] {
  const out: Job[] = [];
  for (const it of asArr(json?.SearchResult?.SearchResultItems)) {
    const d = it?.MatchedObjectDescriptor;
    if (!d || !d.PositionTitle) continue;
    const det = d.UserArea?.Details ?? {};
    const rem = asArr(d.PositionRemuneration)[0];
    const lo = rem ? parseFloat(String(rem.MinimumRange).replace(/,/g, '')) : NaN;
    const hi = rem ? parseFloat(String(rem.MaximumRange).replace(/,/g, '')) : NaN;
    const payRaw: PayRaw | null = rem && (isFinite(lo) || isFinite(hi))
      ? { min: isFinite(lo) ? lo : null, max: isFinite(hi) ? hi : null, interval: intervalFrom(rem.Description ?? (rem.RateIntervalCode === 'PA' ? 'per year' : rem.RateIntervalCode === 'PH' ? 'per hour' : '')), currency: 'USD', noteText: String(rem.Description ?? '') }
      : null;
    const remote = det.RemoteIndicator === true || String(det.RemoteIndicator).toLowerCase() === 'true' || /\bremote\b/i.test(String(d.PositionLocationDisplay ?? ''));
    const posted = d.PublicationStartDate && !isNaN(Date.parse(d.PublicationStartDate)) ? new Date(d.PublicationStartDate).toISOString() : null;
    const desc = [
      det.JobSummary, ...asArr(det.MajorDuties).map(String), det.Requirements, det.Education, d.QualificationSummary,
    ].filter(Boolean).map((s) => htmlToText(String(s))).join('\n');
    out.push({
      source: 'usajobs',
      id: String(it.MatchedObjectId ?? d.PositionID),
      company: String(d.OrganizationName ?? d.DepartmentName ?? ''),
      title: String(d.PositionTitle),
      location: remote ? 'Remote' : String(d.PositionLocationDisplay ?? asArr(d.PositionLocation)[0]?.LocationName ?? ''),
      description: desc,
      url: String(d.PositionURI ?? asArr(d.ApplyURI)[0] ?? ''),
      remote: remote || undefined,
      payRaw,
      postedAt: posted, postedSource: posted ? 'published' : null,
    });
  }
  return out;
}

export async function fetchUsaJobs(cfg: { keyword: string; location?: string; remote?: boolean }): Promise<Job[]> {
  const key = process.env.USAJOBS_API_KEY, email = process.env.USAJOBS_EMAIL;
  if (!key || !email) throw new Error(USAJOBS_NEEDS);
  const q = new URLSearchParams({ Keyword: cfg.keyword, ResultsPerPage: '50', SortField: 'opendate', SortDirection: 'desc', Fields: 'Full' });
  if (cfg.location) q.set('LocationName', cfg.location);
  if (cfg.remote) q.set('RemoteIndicator', 'True');
  const res = await feedFetch(`https://data.usajobs.gov/api/search?${q}`, { headers: { Host: 'data.usajobs.gov', 'User-Agent': email, 'Authorization-Key': key } });
  if (!res.ok) throw new Error(`usajobs: HTTP ${res.status}`);
  return parseUsaJobs(await res.json());
}
