import type { Job } from '../types.js';
import { politeFetch } from '../http.js';
import { intervalFrom, type PayRaw } from '../pay.js';

export const leverUrl = (slug: string) => `https://api.lever.co/v0/postings/${slug}?mode=json`;

/** Verified fields (real responses): salaryRange {min, max, currency, interval: 'per-year-salary'} and salaryDescriptionPlain.
 * Only 'per-year-salary' was observed; other intervals are mapped by keyword (year/hour/month/week) else treated as unknown. */
export function leverPay(j: any): PayRaw | null {
  const r = j.salaryRange;
  if (!r || (r.min == null && r.max == null)) return null;
  return { min: r.min ?? null, max: r.max ?? null, interval: intervalFrom(r.interval), currency: r.currency ?? null, noteText: String(j.salaryDescriptionPlain ?? '') };
}

export function parseLever(json: any, company: string): Job[] {
  return (Array.isArray(json) ? json : []).map((j: any): Job => {
    const lists = (j.lists ?? []).map((l: any) => `${l.text}\n${String(l.content ?? '').replace(/<[^>]+>/g, ' ')}`).join('\n');
    const sr = j.salaryRange;
    return {
      source: 'lever',
      id: String(j.id),
      company,
      title: String(j.text ?? ''),
      location: String(j.categories?.location ?? ''),
      description: [j.descriptionPlain ?? '', lists, j.additionalPlain ?? ''].filter(Boolean).join('\n'),
      url: String(j.hostedUrl ?? ''),
      payRaw: leverPay(j),
      postedAt: typeof j.createdAt === 'number' ? new Date(j.createdAt).toISOString() : null, postedSource: typeof j.createdAt === 'number' ? 'created' : null,   // verified: createdAt = epoch ms, the only date field Lever's public API returns
      workplaceRaw: j.workplaceType ?? null,   // verified values: remote | hybrid | onsite
      pay: sr?.min ? `${sr.currency ?? '$'} ${sr.min}-${sr.max}${sr.interval ? ' ' + sr.interval : ''}` : undefined,
      remote: String(j.workplaceType ?? '').toLowerCase() === 'remote' || undefined,
    };
  });
}
export async function fetchLever(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(leverUrl(slug));
  if (!res.ok) throw new Error(`lever ${slug}: HTTP ${res.status}`);
  return parseLever(await res.json(), company);
}
