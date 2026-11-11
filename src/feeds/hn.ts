import type { Job } from '../types.js';
import { decodeEntities, htmlToText } from '../adapters/text.js';
import { feedFetch } from './http.js';

const ROLE_RE = /\b(engineer|developer|designer|manager|scientist|analyst|architect|lead|director|intern|sre|devops|researcher|consultant|specialist|administrator|recruiter|representative|founder|programmer|swe|sales|support|product|marketing|operations|writer|head of|vp)\b/i;
const REMOTE_RE = /\bremote\b/i;
const ARRANGEMENT_RE = /^(remote|onsite|on-site|hybrid|in[- ]office)\b/i;
const EMPLOYMENT_RE = /^(full[- ]?time|part[- ]?time|contract|contractor|internship|intern|freelance|permanent|visa|h1b)\b/i;
const MONEY_RE = /[$£€]\s?\d|\d\s?k\b|\bsalary\b|\bequity\b/i;

const firstLink = (html: string): string | null => {
  const m = html.match(/<a\s[^>]*href="([^"]+)"/i);
  if (!m) return null;
  const u = decodeEntities(m[1]);
  return /^https?:\/\//i.test(u) ? u : null;
};

export const hnPlain = (html: string): string => htmlToText(html.replace(/<p>/gi, '\n'));

/** Parses the top-level comments of one "Ask HN: Who is hiring?" thread (Algolia /items/<id> `children`, or search hits whose parent_id is the story).
 * Shape verified live: {id, author, created_at, parent_id, text (HTML, paragraphs separated by <p>), children[]}.
 * Only comments that look like job posts (header line "Company | Role | Location | ..." ) are kept; replies/chatter are skipped. */
export function parseHn(children: any[], storyId?: string | number): Job[] {
  const out: Job[] = [];
  for (const c of Array.isArray(children) ? children : []) {
    if (!c || typeof c.text !== 'string' || !c.text.trim() || c.id == null) continue;
    if (c.type && c.type !== 'comment') continue;
    if (storyId != null && c.parent_id != null && String(c.parent_id) !== String(storyId)) continue;   // top-level only
    const text = hnPlain(c.text);
    const head = text.split('\n')[0].trim();
    // header = leading "|" segments; a segment over 150 chars is prose that ran on without a paragraph break, so the header ends there
    const all = head.split('|').map((s) => s.trim()).filter(Boolean);
    const cut = all.findIndex((s) => s.length > 150);
    const segs = (cut < 0 ? all : all.slice(0, cut)).slice(0, 8);
    if (segs.length < 2) continue;
    if (segs.length === 2 && !ROLE_RE.test(segs[1]) && !REMOTE_RE.test(segs[1])) continue;
    const company = segs[0].replace(/\s+/g, ' ');
    if (!company || company.length > 120) continue;
    const rest = segs.slice(1);
    const remoteSeg = rest.find((s) => REMOTE_RE.test(s) && s.length <= 40);
    const roleSeg = rest.find((s) => ROLE_RE.test(s) && !ARRANGEMENT_RE.test(s) && !MONEY_RE.test(s) && !/^https?:/i.test(s))
      ?? rest.find((s) => !ARRANGEMENT_RE.test(s) && !EMPLOYMENT_RE.test(s) && !MONEY_RE.test(s) && !/^https?:|^[\w.-]+\.\w{2,}(\/|$)/i.test(s) && s.length <= 100 && !/,/.test(s));
    const place = rest.find((s) => s !== roleSeg && s !== remoteSeg && !ARRANGEMENT_RE.test(s) && !EMPLOYMENT_RE.test(s) && !MONEY_RE.test(s) && !/^https?:|\.\w{2,}\//i.test(s) && s.length <= 80);
    const remote = !!remoteSeg;
    let location = place ?? '';
    if (remote) {
      const detail = remoteSeg!.match(/\(([^)]+)\)/)?.[1];
      location = 'Remote' + (detail ? ` (${detail})` : '') + (place ? ` - ${place}` : '');
    }
    const created = typeof c.created_at === 'string' && !isNaN(Date.parse(c.created_at)) ? new Date(c.created_at).toISOString() : null;
    out.push({
      source: 'hn',
      id: String(c.id),
      company,
      title: roleSeg ?? 'Open roles',
      location,
      description: text,
      url: firstLink(c.text) ?? `https://news.ycombinator.com/item?id=${c.id}`,
      remote: remote || undefined,
      postedAt: created, postedSource: created ? 'published' : null,   // comment created_at = when the post was made
    });
  }
  return out;
}

const ALGOLIA = 'https://hn.algolia.com/api/v1';

/** Latest "Ask HN: Who is hiring?" thread(s) by user whoishiring, then their top-level comments (one /items request per thread). */
export async function fetchHn(cfg: { threads?: number } = {}): Promise<Job[]> {
  const res = await feedFetch(`${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`);
  if (!res.ok) throw new Error(`hn: HTTP ${res.status} listing threads`);
  const hits: any[] = ((await res.json()) as any).hits ?? [];
  const threads = hits.filter((h) => /who is hiring/i.test(String(h.title ?? ''))).slice(0, Math.max(1, cfg.threads ?? 1));
  if (!threads.length) throw new Error('hn: no "Who is hiring?" thread found');
  const jobs: Job[] = [];
  for (const t of threads) {
    const r = await feedFetch(`${ALGOLIA}/items/${encodeURIComponent(String(t.objectID))}`);
    if (!r.ok) throw new Error(`hn: HTTP ${r.status} reading thread ${t.objectID}`);
    const story: any = await r.json();
    jobs.push(...parseHn(story.children ?? [], story.id ?? t.objectID));
  }
  return jobs;
}
