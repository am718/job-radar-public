import type { Job } from '../types.js';
import { decodeEntities, htmlToText } from '../adapters/text.js';
import { feedFetch } from './http.js';

const tag = (item: string, name: string): string | null => {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
};
/** Element text: CDATA is taken verbatim, otherwise XML entities are decoded once. */
const xmlText = (raw: string | null): string => {
  if (raw == null) return '';
  const t = raw.trim();
  const c = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return c ? c[1].trim() : decodeEntities(t);
};

/** We Work Remotely category RSS. Verified item fields: title ("Company: Title"), region, category, description (HTML, XML-escaped), pubDate (RFC 822), guid, link. */
export function parseWwr(xml: string): Job[] {
  const out: Job[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const full = xmlText(tag(it, 'title'));
    const url = xmlText(tag(it, 'link')) || xmlText(tag(it, 'guid'));
    if (!full || !url) continue;
    const i = full.indexOf(': ');
    const company = i > 0 ? full.slice(0, i).trim() : '';
    const title = i > 0 ? full.slice(i + 2).trim() : full;
    const region = xmlText(tag(it, 'region'));
    const pub = xmlText(tag(it, 'pubDate'));
    const when = pub && !isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null;
    out.push({
      source: 'wwr',
      id: xmlText(tag(it, 'guid')) || url,
      company,
      title,
      location: !region || /anywhere/i.test(region) ? 'Remote' : `Remote (${region})`,
      description: htmlToText(xmlText(tag(it, 'description'))),
      url,
      remote: true,
      postedAt: when, postedSource: when ? 'published' : null,
    });
  }
  return out;
}

export const wwrUrl = (cat: string) => (/^https?:\/\//.test(cat) ? cat : `https://weworkremotely.com/categories/${cat.replace(/\.rss$/, '')}.rss`);

export async function fetchWwr(cfg: { categories: string[] }): Promise<Job[]> {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const cat of cfg.categories) {
    const res = await feedFetch(wwrUrl(cat), { accept: 'application/rss+xml, application/xml, text/xml' });
    if (!res.ok) throw new Error(`wwr ${cat}: HTTP ${res.status}`);
    for (const j of parseWwr(await res.text())) if (!seen.has(j.id)) { seen.add(j.id); out.push(j); }
  }
  return out;
}
