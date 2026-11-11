import type { Job } from '../types.js';
import { htmlToText, decodeEntities } from './text.js';
import { politeFetch } from '../http.js';
import { intervalFrom, type PayRaw } from '../pay.js';

/** Verified (real responses, <slug>.jobs.personio.de/xml and .com): <workzag-jobs><position> with id, subcompany?, office, additionalOffices/office*,
 * department, recruitingCategory?, name, jobDescriptions/jobDescription{name,value(CDATA HTML)}, employmentType, seniority, schedule, createdAt (ISO),
 * and optionally salaryInformation{min,max,currencyCode,type 'yearly'|'hourly'}. The feed has no posting URL: it is <slug>.jobs.personio.de/job/<id>.
 * One request returns everything, so no detail calls. An empty board returns an empty <workzag-jobs/>; an unknown slug returns HTTP 404. */
export const personioBoardUrl = (slug: string) => `https://${slug}.jobs.personio.de/xml`;

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const text = (s: string) => decodeEntities(unCdata(s)).trim();
const tag = (x: string, t: string): string | null => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(x); return m ? m[1] : null; };
const num = (v: string | null) => { const n = v == null ? NaN : parseFloat(v); return Number.isFinite(n) ? n : null; };
const isoOrNull = (v: string | null) => { const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export function parsePersonio(xml: string, company: string, slug: string): Job[] {
  if (typeof xml !== 'string') return [];
  const out: Job[] = [];
  for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/g)) {
    const p = m[1];
    const id = tag(p, 'id')?.trim(), title = tag(p, 'name');
    if (!id || !title) continue;
    const additional = tag(p, 'additionalOffices');
    const extra = additional ? [...additional.matchAll(/<office>([\s\S]*?)<\/office>/g)].map((x) => x[1]) : [];
    const main = /<office>([\s\S]*?)<\/office>/.exec(p.replace(/<additionalOffices>[\s\S]*?<\/additionalOffices>/, ''));
    const locs = [main ? main[1] : '', ...extra].map((x) => text(x)).filter(Boolean);
    const location = [...new Set(locs)].join('; ');
    const sections = [...p.matchAll(/<jobDescription>\s*<name>([\s\S]*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/jobDescription>/g)]
      .map((s) => { const body = htmlToText(unCdata(s[2])); return body ? `${text(s[1])}\n${body}` : ''; }).filter(Boolean);
    const created = isoOrNull(tag(p, 'createdAt'));
    const sal = tag(p, 'salaryInformation');
    let payRaw: PayRaw | null = null;
    if (sal) {
      const min = num(tag(sal, 'min')), max = num(tag(sal, 'max'));
      if (min != null || max != null) payRaw = { min, max, interval: intervalFrom(tag(sal, 'type')), currency: tag(sal, 'currencyCode')?.trim() || null, noteText: '' };
    }
    out.push({
      source: 'personio', id, company,
      title: text(title),
      location,
      description: sections.join('\n\n'),
      url: `https://${slug}.jobs.personio.de/job/${id}`,
      remote: /remote/i.test(location) || undefined,
      postedAt: created, postedSource: created ? 'created' : null,
      workplaceRaw: null,   // the feed has no structured work-arrangement field (office text only)
      payRaw,
    });
  }
  return out;
}

export async function fetchPersonio(slug: string, company: string): Promise<Job[]> {
  let res = await politeFetch(personioBoardUrl(slug));
  if (res.status === 404) res = await politeFetch(`https://${slug}.jobs.personio.com/xml`);   // some tenants only exist on .com
  if (!res.ok) throw new Error(`personio ${slug}: HTTP ${res.status}`);
  return parsePersonio(await res.text(), company, slug);
}
