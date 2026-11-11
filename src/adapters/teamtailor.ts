import type { Job } from '../types.js';
import { htmlToText, decodeEntities } from './text.js';
import { politeFetch } from '../http.js';

/** Verified (real responses, <slug>.teamtailor.com/jobs.rss): RSS 2.0 <item> with title, description (entity-escaped HTML), pubDate (RFC 822),
 * link (public posting page), guid (uuid), remoteStatus ('fully' | 'none' | 'hybrid' ...), tt:locations/tt:location{tt:name,tt:city,tt:country}, tt:department.
 * One request returns everything, so no detail calls. Unknown slug -> HTTP 404. No structured salary element was seen (pay appears only in description text). */
export const teamtailorBoardUrl = (slug: string) => `https://${slug}.teamtailor.com/jobs.rss`;

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const tag = (x: string, t: string): string | null => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x); return m ? m[1] : null; };
const clean = (s: string | null) => (s == null ? '' : decodeEntities(unCdata(s)).trim());

export function parseTeamtailor(xml: string, company: string): Job[] {
  if (typeof xml !== 'string') return [];
  const out: Job[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = clean(tag(it, 'title')), link = clean(tag(it, 'link'));
    if (!title || !link) continue;
    const guid = clean(tag(it, 'guid')) || link;
    const remoteStatus = clean(tag(it, 'remoteStatus')).toLowerCase();
    const locs = [...it.matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/g)].map((l) =>
      [clean(tag(l[1], 'tt:city')) || clean(tag(l[1], 'tt:name')), clean(tag(l[1], 'tt:country'))].filter(Boolean).join(', ')).filter(Boolean);
    const remote = remoteStatus === 'fully';
    const uniq = [...new Set(locs)];
    if (remote && !uniq.some((l) => /remote/i.test(l))) uniq.push('Remote');
    const desc = clean(tag(it, 'description'));
    const t = Date.parse(clean(tag(it, 'pubDate')));
    out.push({
      source: 'teamtailor', id: guid, company, title,
      location: uniq.join('; '),
      description: htmlToText(desc),
      url: link,
      remote: remote || undefined,
      postedAt: Number.isNaN(t) ? null : new Date(t).toISOString(), postedSource: Number.isNaN(t) ? null : 'published',   // pubDate = publication time of the posting
      workplaceRaw: remoteStatus || null,   // observed: fully | none (others, e.g. hybrid, passed through verbatim)
      payRaw: null,
    });
  }
  return out;
}

export async function fetchTeamtailor(slug: string, company: string): Promise<Job[]> {
  const res = await politeFetch(teamtailorBoardUrl(slug));
  if (!res.ok) throw new Error(`teamtailor ${slug}: HTTP ${res.status}`);
  return parseTeamtailor(await res.text(), company);
}
