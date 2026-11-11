import crypto from 'node:crypto';
import type { Job } from '../types.js';
import { htmlToText, decodeEntities } from '../adapters/text.js';
import { isoOrNull } from '../adapters/greenhouse.js';
import { intervalFrom, type PayRaw } from '../pay.js';

export const sha16 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const TRACKING = /^(utm_.*|gh_src|gh_jid_src|fbclid|gclid|mc_.*|ref|referrer|source|src|trk|trackingid|lipi|midtoken|refid|campaign)$/i;
/** Canonical form used for ids: no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw); u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch { return raw; }
}

const ghText = (c: string) => htmlToText(!c.includes('<') && c.includes('&lt;') ? decodeEntities(c) : c);
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: any): string => (typeof v === 'string' ? v.trim() : typeof v?.name === 'string' ? v.name.trim() : '');

function findJobPosting(node: any): any | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findJobPosting(n); if (r) return r; } return null; }
  if (arr(node['@type']).some((t: string) => /^JobPosting$/i.test(String(t)))) return node;
  return findJobPosting(node['@graph']);
}
function jsonLdBlocks(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* skip malformed */ }
  }
  return out;
}
function locationOf(jp: any): string {
  const parts = arr(jp.jobLocation).map((l: any) => {
    const a = l?.address ?? l;
    if (typeof a === 'string') return a.trim();
    return [str(a?.addressLocality), str(a?.addressRegion), str(a?.addressCountry)].filter(Boolean).join(', ');
  }).filter(Boolean);
  return [...new Set(parts)].join(' | ');
}
function payOf(jp: any): PayRaw | null {
  const s = jp.baseSalary; if (!s || typeof s !== 'object') return null;
  const v = s.value;
  const num = (x: any) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
  const min = num(typeof v === 'object' && v ? (v.minValue ?? v.value) : v), max = num(typeof v === 'object' && v ? (v.maxValue ?? v.value) : v);
  if (min == null && max == null) return null;
  const unit = typeof v === 'object' && v ? v.unitText : s.unitText;
  return { min, max, interval: intervalFrom(String(unit ?? '')), currency: str(s.currency) || (typeof v === 'object' ? str(v?.currency) : '') || null, noteText: '' };
}

const meta = (html: string, prop: string): string => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    if (new RegExp(`(?:property|name)\\s*=\\s*["']${prop}["']`, 'i').test(t)) { const c = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(t); if (c) return decodeEntities(c[1] ?? c[2]).trim(); }
  }
  return '';
};
const hostName = (url: string) => { try { return new URL(url).hostname.replace(/^(www|jobs|careers|apply|boards)\./i, '').split('.').slice(0, -1).join(' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()) || new URL(url).hostname; } catch { return ''; } };
const stripChrome = (html: string) => html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

/** Builds a Job (source 'link') from a job page's HTML. Prefers schema.org JSON-LD JobPosting; otherwise og:/title/h1 + main text. */
export function extractJobPosting(html: string, url: string): Job {
  const canon = canonicalUrl(url), base = { source: 'link' as const, id: sha16(canon), url: canon };
  const jp = findJobPosting(jsonLdBlocks(html));
  if (jp) {
    const remote = /TELECOMMUTE/i.test(String(jp.jobLocationType ?? ''));
    let location = locationOf(jp);
    if (remote) location = location ? `Remote | ${location}` : 'Remote';
    const posted = isoOrNull(jp.datePosted);
    return {
      ...base,
      company: str(jp.hiringOrganization) || meta(html, 'og:site_name') || hostName(url),
      title: decodeEntities(str(jp.title)) || meta(html, 'og:title'),
      location, remote: remote || undefined,
      description: ghText(String(jp.description ?? '')),
      payRaw: payOf(jp), postedAt: posted, postedSource: posted ? 'published' : null,
      workplaceRaw: remote ? 'Remote' : null,
    };
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html), tt = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = meta(html, 'og:title') || (h1 ? htmlToText(h1[1]) : '') || (tt ? htmlToText(tt[1]) : '');
  const body = (/<main\b[\s\S]*?<\/main>/i.exec(html) ?? /<article\b[\s\S]*?<\/article>/i.exec(html) ?? /<body\b[\s\S]*<\/body>/i.exec(html) ?? [html])[0];
  const description = htmlToText(stripChrome(body));
  const loc = /(?:^|\n)\s*(?:location|where)\s*[:\-]\s*([^\n]{2,80})/i.exec(description);
  return {
    ...base,
    company: meta(html, 'og:site_name') || hostName(url),
    title: title.replace(/\s*[|–-]\s*(careers|jobs).*$/i, '').trim() || title,
    location: loc ? loc[1].trim() : '',
    description, postedAt: null, postedSource: null,
  };
}
