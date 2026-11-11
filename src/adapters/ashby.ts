import type { Job } from '../types.js';
import { politeFetch } from '../http.js';
import { ANNUALIZE, intervalFrom, type PayRaw } from '../pay.js';

export const ashbyUrl = (slug: string) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;

/** Verified fields (real responses, includeCompensation=true): compensation.compensationTiers[].components[] with
 * compensationType ('Salary' | 'EquityPercentage' | 'EquityCashValue' | 'Bonus' | 'Commission'), interval ('1 YEAR' | '1 HOUR' | '1 MONTH' | '1 WEEK' | 'NONE'),
 * currencyCode, minValue, maxValue; plus compensationTierSummary text. Only Salary components are read; equity/bonus/commission components are ignored.
 * Multiple tiers: union of annualized Salary ranges. */
export function ashbyPay(j: any): PayRaw | null {
  const tiers: any[] = j.compensation?.compensationTiers ?? [];
  const sal = tiers.flatMap((t) => (t.components ?? []).filter((c: any) => c.compensationType === 'Salary' && (c.minValue != null || c.maxValue != null)));
  if (!sal.length) return null;
  const usdSal = sal.filter((c) => String(c.currencyCode ?? '').toUpperCase() === 'USD');
  const use = usdSal.length ? usdSal : sal;
  const ann = use.map((c) => { const m = ANNUALIZE[intervalFrom(c.interval)]; return { lo: (c.minValue ?? c.maxValue) * m, hi: (c.maxValue ?? c.minValue) * m }; });
  const bad = ann.some((a) => !Number.isFinite(a.lo));
  return {
    min: bad ? null : Math.min(...ann.map((a) => a.lo)), max: bad ? null : Math.max(...ann.map((a) => a.hi)),
    interval: bad ? 'unknown' : 'year', currency: use[0].currencyCode ?? null, trustTyped: true,   // decision: a typed Salary component is base pay even if the text mentions OTE/commission
    noteText: [j.compensation?.compensationTierSummary, ...tiers.map((t) => t.tierSummary), ...use.map((c) => c.summary)].filter(Boolean).join(' | '),
  };
}

export function parseAshby(json: any, company: string): Job[] {
  return (json?.jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any): Job => {
    const secondary = (j.secondaryLocations ?? []).map((l: any) => l.location ?? l).filter(Boolean);
    return {
      source: 'ashby',
      id: String(j.id),
      company,
      title: String(j.title ?? ''),
      location: [j.location, ...secondary].filter(Boolean).join(' | '),
      description: String(j.descriptionPlain ?? ''),
      url: String(j.jobUrl ?? ''),
      payRaw: ashbyPay(j),
      postedAt: Number.isNaN(Date.parse(j.publishedAt ?? '')) ? null : new Date(j.publishedAt).toISOString(), postedSource: Number.isNaN(Date.parse(j.publishedAt ?? '')) ? null : 'published',   // verified: publishedAt exists on every listed job
      workplaceRaw: j.workplaceType ?? null,   // verified values: Remote | Hybrid | OnSite | null (isRemote is true for Hybrid too, so it is NOT used)
      pay: j.compensation?.compensationTierSummary || undefined,
      remote: j.isRemote === true ? true : undefined,
    };
  });
}
export async function fetchAshby(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(ashbyUrl(slug));
  if (!res.ok) throw new Error(`ashby ${slug}: HTTP ${res.status}`);
  return parseAshby(await res.json(), company);
}
