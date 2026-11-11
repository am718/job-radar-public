import type Database from 'better-sqlite3';
import { simpleParser } from 'mailparser';
import type { Job } from '../types.js';
import type { LlmFn } from '../scoring/scorer.js';
import type { ScanStats } from '../pipeline.js';
import { htmlToText, decodeEntities } from '../adapters/text.js';
import { isForbiddenHost, normHost } from './hosts.js';
import { parseAtsUrl, fetchAtsJob } from './atsurl.js';
import { resolveRedirect } from './redirect.js';
import { canonicalUrl, sha16 } from './extract.js';
import type { FetchFn } from './net.js';
import { storeAndScore } from './store.js';

export type LinkKind = 'linkedin' | 'indeed' | 'handshake' | 'ats' | 'other';
export interface FoundLink { url: string; kind: LinkKind; title: string; company?: string; location?: string; snippet: string }

const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|recruitee\.com|bamboohr\.com|breezy\.hr|teamtailor\.com|personio\.(de|com)|rippling\.com|dover\.com|applytojob\.com|paylocity\.com|ultipro\.com)$/;

/** Classifies an href and normalises job links of the forbidden sites to a tracking-free URL (as plain text: it is never requested). null = not a job link we recognise. */
export function classifyLink(href: string): { kind: LinkKind; url: string } | null {
  let u: URL; try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = normHost(u.hostname);
  if (/(^|\.)linkedin\.com$/.test(h)) {
    const m = /^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{5,})/.exec(u.pathname);
    return m ? { kind: 'linkedin', url: `https://www.linkedin.com/jobs/view/${m[1]}` } : null;
  }
  if (/(^|\.)indeed\.[a-z.]+$/.test(h)) {
    const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
    return jk && /^[0-9a-f]{8,}$/i.test(jk) && /(viewjob|rc\/clk|pagead\/clk|m\/basecamp|clk)/.test(u.pathname) ? { kind: 'indeed', url: `https://www.indeed.com/viewjob?jk=${jk}` } : null;
  }
  if (/(^|\.)joinhandshake\.com$/.test(h)) {
    const m = /^\/(?:stu\/|emp\/)?(?:jobs|postings)\/(\d+)/.exec(u.pathname);
    return m ? { kind: 'handshake', url: `https://${h}/jobs/${m[1]}` } : null;
  }
  if (isForbiddenHost(h)) return null;
  if (parseAtsUrl(href)) return { kind: 'ats', url: canonicalUrl(href) };
  if (ATS_HOSTS.test(h)) return u.pathname.split('/').filter(Boolean).length >= 2 ? { kind: 'ats', url: canonicalUrl(href) } : null;
  return { kind: 'other', url: href };
}

const SKIP_RE = /unsubscribe|opt[- ]?out|manage\b.*\b(email|alert|notification|subscription|preference)s?|email preferences|notification settings|\bsettings\b|privacy|terms of (use|service)|user agreement|help (center|centre)|\bhelp\b|view (this )?(email )?in (your )?(web )?browser|edit (your )?(alert|profile)|update (your )?(profile|preferences)|see all|more jobs|view all|contact us|download the app|app store|google play|forward to a friend|\bprofile\b|\bfeedback\b|why am i receiving|safe unsubscribe|cookie/i;
const CTA_RE = /^(view|apply|see|easy apply|view job|apply now|learn more|view details|view role|see job|open|read more|click here|get started|quick apply)\b/i;
const JOB_WORDS = /\b(engineer|developer|analyst|manager|designer|associate|intern|internship|specialist|scientist|consultant|coordinator|representative|architect|administrator|technician|researcher|director|recruiter|strategist|writer|support|sales|marketing|operations|product|data|software|account|solutions|program|programmer|agent|lead|officer|assistant)\b/i;
const JUNK_RE = /^(easy apply|actively (recruiting|hiring)|be an early applicant|promoted|new|apply( now)?|view job|\d+ (school )?alum.*|you'?d be a top applicant|\d+(\.\d+)?\s*★?|.*\bago$|\d+ applicants?|sponsored|top applicant|reposted.*|responses? managed.*|hiring now)$/i;
const looksLocation = (s: string) => /,\s*[A-Z]{2}\b|\bremote\b|\bhybrid\b|on-?site|united states|\busa\b|\bnew york\b|\bmetropolitan\b|\barea\b/i.test(s);

function interpret(lines: string[], haveCompany = false): { company?: string; location?: string; extras: string[] } {
  let company: string | undefined, location: string | undefined; const extras: string[] = [];
  for (const raw of lines.slice(0, 8)) {
    const line = raw.trim();
    if (!line || JUNK_RE.test(line) || CTA_RE.test(line) && line.length < 25) continue;
    if (/\$\s?\d/.test(line) || /^(full|part)[- ]time\b|^internship\b|^contract\b/i.test(line)) { extras.push(line); continue; }
    if (!company && !haveCompany) {
      const dot = line.split(/\s+[·•|]\s+/);
      const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(line);
      if (dot.length >= 2) { company = dot[0]; location = dot[1]; }
      else if (dash && looksLocation(dash[2])) { company = dash[1]; location = dash[2]; }
      else if (!looksLocation(line) || line.length < 4) company = line;
      else location = line;
    } else if (!location && looksLocation(line) && line.length < 80) location = line;
    else extras.push(line);
  }
  return { company, location, extras: extras.slice(0, 4) };
}

interface Marker { idx: number; href: string; text: string; cls: { kind: LinkKind; url: string } }
const M_RE = /^\u0001(\d+)\u0002([\s\S]*)\u0003$/;
const NAMED: Record<string, string> = { middot: '\u00b7', bull: '\u2022', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', star: '\u2605', copy: '\u00a9' };
const decode = (s: string) => decodeEntities(s.replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m));
const clean = (s: string) => decode(s).replace(/\s+/g, ' ').trim();

function fromHtml(html: string): FoundLink[] {
  const markers: Marker[] = [];
  let body = html.replace(/<head[\s\S]*?<\/head>/gi, ' ').replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const hm = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const text = clean(htmlToText(inner.replace(/<img\b[^>]*>/gi, '')));
    if (!hm || !text) return ` ${text} `;
    const href = decode(hm[1] ?? hm[2] ?? hm[3]).trim();
    const cls = classifyLink(href);
    if (!cls) return ` ${text} `;
    if (cls.kind === 'other' && (SKIP_RE.test(text) || SKIP_RE.test(href) || !(JOB_WORDS.test(text) || /^(apply|view)\b.*\b(job|role|position)|^apply/i.test(text)))) return ` ${text} `;
    markers.push({ idx: markers.length, href, text, cls });
    return `\n\u0001${markers.length - 1}\u0002${text}\u0003\n`;
  });
  body = body.replace(/<br\s*\/?>|<\/?(p|div|tr|td|th|table|li|ul|ol|h[1-6]|section|tbody|center|span)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  const lines = decode(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pos = lines.map((l) => M_RE.exec(l)).map((m) => (m ? Number(m[1]) : -1));
  const byUrl = new Map<string, { li: number; mk: Marker }>();
  lines.forEach((_l, li) => {
    if (pos[li] < 0) return;
    const mk = markers[pos[li]], prev = byUrl.get(mk.cls.url);
    if (!prev || (CTA_RE.test(prev.mk.text) && !CTA_RE.test(mk.text))) byUrl.set(mk.cls.url, { li, mk });
  });
  const out: FoundLink[] = [];
  for (const { li, mk } of byUrl.values()) {
    let title = mk.text, ctx: string[];
    if (CTA_RE.test(title)) {   // button-style link: the job text sits in the lines before it
      const before: string[] = [];
      for (let i = li - 1; i >= 0 && pos[i] < 0 && before.length < 3; i--) before.unshift(lines[i]);
      const [t, ...rest] = before.filter((l) => !JUNK_RE.test(l));
      title = t ?? ''; ctx = rest;
    } else {
      ctx = []; for (let i = li + 1; i < lines.length && pos[i] < 0 && ctx.length < 8; i++) ctx.push(lines[i]);
    }
    out.push(build(mk.cls, title, ctx));
  }
  return out.filter((l): l is FoundLink => !!l);
}

function build(cls: { kind: LinkKind; url: string }, rawTitle: string, ctx: string[]): FoundLink {
  let title = rawTitle.trim(), co: string | undefined;
  const at = /^(.+?)\s+at\s+(.+)$/i.exec(title);
  if (at) { title = at[1]; co = at[2]; }
  const r = interpret(ctx, !!co), { location, extras } = r;
  co = co ?? r.company;
  return { url: cls.url, kind: cls.kind, title, company: co, location, snippet: extras.join('\n') };
}

function fromText(text: string): FoundLink[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out = new Map<string, FoundLink>();
  const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
  lines.forEach((line, li) => {
    for (const m of line.matchAll(URL_RE)) {
      const cls = classifyLink(m[0].replace(/[.,;]+$/, ''));
      if (!cls || out.has(cls.url)) continue;
      if (cls.kind === 'other') continue;   // plain-text fallback: only recognisable job links
      const label = line.replace(m[0], '').replace(/[<\[\]>]/g, '').replace(/\s*[:\-–]\s*$/, '').trim();
      const before: string[] = [];
      for (let i = li - 1; i >= 0 && lines[i] && !URL_RE.test(lines[i]) && before.length < 3; i--) { URL_RE.lastIndex = 0; before.unshift(lines[i]); }
      URL_RE.lastIndex = 0;
      const block = before.filter((l) => !JUNK_RE.test(l));
      const lbl = label && !CTA_RE.test(label) && !/^(view|apply)/i.test(label) ? [label] : [];
      const [t, ...rest] = [...lbl, ...block];
      if (t) out.set(cls.url, build(cls, t, rest));
    }
  });
  return [...out.values()];
}

/** Job links (title, company, location when present) from an alert email: HTML anchors first, plain-text fallback. */
export function extractAlertLinks(msg: { html?: string | false | null; text?: string | null }): FoundLink[] {
  let found = msg.html ? fromHtml(msg.html) : [];
  if (!found.length && msg.text) found = fromText(msg.text);
  return found.filter((l) => l.title && (l.kind !== 'other' || JOB_WORDS.test(l.title)));
}

export interface IngestSummary { emails: number; links: number; resolved: number; added: number; duplicates: number; skippedForbidden: number; atsFetched: number; filtered: number; scored: number; errors: string[] }
export interface IngestDeps { fetch: FetchFn; llm: LlmFn | null; ghHostSlugs?: Record<string, string> }

const hostLabel = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0] ?? ''; } catch { return ''; } };

/** Parses raw RFC822 messages and stores every alert job found. Never requests a forbidden host. */
export async function ingestEmails(db: Database.Database, raws: (Buffer | string)[], deps: IngestDeps): Promise<IngestSummary> {
  const sum: IngestSummary = { emails: 0, links: 0, resolved: 0, added: 0, duplicates: 0, skippedForbidden: 0, atsFetched: 0, filtered: 0, scored: 0, errors: [] };
  const jobs: Job[] = [];
  for (const raw of raws) {
    let parsed;
    try { parsed = await simpleParser(raw); } catch (e) { sum.errors.push(`unreadable email: ${(e as Error).message}`); continue; }
    sum.emails++;
    const dateIso = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null;
    const found = extractAlertLinks({ html: parsed.html, text: parsed.text });
    sum.links += found.length;
    for (const l of found) {
      let finalUrl = l.url;
      if (l.kind === 'linkedin' || l.kind === 'indeed' || l.kind === 'handshake') sum.skippedForbidden++;
      else if (l.kind === 'other' || !parseAtsUrl(l.url)) {
        const r = await resolveRedirect(l.url, { fetch: deps.fetch });
        if (r.url !== l.url) sum.resolved++;
        finalUrl = r.url;
        if (r.skippedForbidden) {
          sum.skippedForbidden++;
          const c = r.blockedUrl ? classifyLink(r.blockedUrl) : null;
          if (c) finalUrl = c.url;   // keep the forbidden job URL as text only
        }
      }
      const ref = parseAtsUrl(finalUrl, deps.ghHostSlugs);
      let job: Job | null = null;
      if (ref) {
        try { job = await fetchAtsJob(ref, deps.fetch); if (job) sum.atsFetched++; } catch (e) { sum.errors.push(`ats fetch ${ref.source}/${ref.slug}: ${(e as Error).message}`); }
      }
      if (!job) {
        const fin = canonicalUrl(finalUrl);
        job = {
          source: 'alert', id: sha16(fin), company: l.company || hostLabel(fin).replace(/^./, (c) => c.toUpperCase()) || 'Unknown', title: l.title, location: l.location ?? '',
          description: l.snippet || `${l.title}${l.company ? ' at ' + l.company : ''} (from a job-alert email)`, url: finalUrl,
          postedAt: null, postedSource: null, updatedRaw: dateIso,
        };
      }
      jobs.push(job);
    }
  }
  const stats: ScanStats = { fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] };
  const outcomes = await storeAndScore(db, jobs, deps.llm, stats);
  sum.added = outcomes.filter((o) => o.status === 'new').length;
  sum.duplicates = jobs.length - sum.added;
  sum.filtered = outcomes.filter((o) => o.status === 'new' && o.filterReason).length;
  sum.scored = stats.scored;
  sum.errors.push(...stats.errors);
  return sum;
}
