import type { Job } from '../types.js';
import { htmlToText } from '../adapters/text.js';
import type { PayRaw } from '../pay.js';
import { feedFetch } from './http.js';

export const REMOTEOK_ATTRIBUTION = 'Source: Remote OK (remoteok.com)';

/** Remote OK API: element 0 is a legal notice ({legal, last_updated}); the rest are jobs.
 * Terms (quoted in that notice): link back to the Remote OK job URL and name Remote OK as the source. url is kept as Remote OK's own url and the description starts with the attribution line.
 * Verified fields: id, slug, epoch, date (ISO), company, position, tags[], description (HTML), location (often ''), url, apply_url, salary_min/salary_max (0 when absent). */
export function parseRemoteOk(json: any, tags?: string[]): Job[] {
  const want = (tags ?? []).map((t) => t.toLowerCase());
  const out: Job[] = [];
  for (const j of Array.isArray(json) ? json : []) {
    if (!j || j.legal || j.id == null || !j.position) continue;
    if (want.length) {
      const have = (Array.isArray(j.tags) ? j.tags : []).map((t: string) => String(t).toLowerCase());
      if (!want.some((t) => have.includes(t))) continue;
    }
    const lo = Number(j.salary_min) || 0, hi = Number(j.salary_max) || 0;
    // assumption (not documented): Remote OK salary figures are annual USD
    const payRaw: PayRaw | null = lo || hi ? { min: lo || null, max: hi || null, interval: 'year', currency: 'USD', noteText: '' } : null;
    const when = typeof j.date === 'string' && !isNaN(Date.parse(j.date)) ? new Date(j.date).toISOString()
      : typeof j.epoch === 'number' ? new Date(j.epoch * 1000).toISOString() : null;
    const loc = String(j.location ?? '').trim();
    out.push({
      source: 'remoteok',
      id: String(j.id),
      company: String(j.company ?? ''),
      title: String(j.position),
      location: loc ? `Remote (${loc})` : 'Remote',
      description: `${REMOTEOK_ATTRIBUTION}\n${htmlToText(String(j.description ?? ''))}`,
      url: String(j.url ?? `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`),
      remote: true,
      payRaw,
      postedAt: when, postedSource: when ? 'published' : null,
    });
  }
  return out;
}

export async function fetchRemoteOk(cfg: { tags?: string[] } = {}): Promise<Job[]> {
  const res = await feedFetch('https://remoteok.com/api');
  if (!res.ok) throw new Error(`remoteok: HTTP ${res.status}`);
  return parseRemoteOk(await res.json(), cfg.tags);
}
