import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

// LEAK CHECK for the public demo output. Fails the build if the output contains an email, a phone number, the name of any REAL company (the companies this tool scans and the
// companies in the local digest) or a personal string from answers.json. This is the only demo module that reads real data, and it only reads it to FORBID it.
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const PHONE = /(?<![\d.])(\+?\d{1,2}[\s.-]?)?(\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d])|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
const PERSONAL_KEYS = ['name', 'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'address', 'linkedin', 'github', 'portfolio', 'website', 'twitter', 'school', 'current_company', 'cover_letter_path', 'location_query'];

export interface Forbidden { companies: string[]; strings: string[] }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a reader (or the page script) can actually see as DATA: visible text plus the inlined JSON. Markup, CSS and the page's own code are excluded so a company called "Scale" does not
 *  trip on `initial-scale=1`. Emails, phones and answers.json strings are still checked against the WHOLE output. */
export function contentView(html: string): string {
  const cfg = /const CFG = (\{[\s\S]*?\});\s*\n?\s*const \$ =/.exec(html)?.[1] ?? '';
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return `${text}\n${cfg}`;
}
export function findLeaks(output: string, f: Forbidden): string[] {
  const out: string[] = [];
  for (const m of output.match(EMAIL) ?? []) out.push(`email address: ${m}`);
  for (const m of output.match(PHONE) ?? []) out.push(`phone number: ${m.trim()}`);
  const low = output.toLowerCase(), view = contentView(output).toLowerCase();
  for (const c of new Set(f.companies.map((x) => x.trim()).filter((x) => x.length >= 3))) if (new RegExp(`(^|[^a-z0-9])${esc(c.toLowerCase())}($|[^a-z0-9])`)  .test(view)) out.push(`real company name: ${c}`);
  for (const s of new Set(f.strings.map((x) => x.trim()).filter((x) => x.length >= 4))) if (low.includes(s.toLowerCase())) out.push(`string from answers.json: "${s.length > 4 ? s.slice(0, 2) + '…' + s.slice(-1) : '…'}" (${s.length} chars)`);   // the value itself is never printed
  return out;
}

/** Real company names (companies.json + every company in the local database) and personal strings from answers.json. Whatever is not present on this machine is simply not checked, and the report says so. */
export function gatherForbidden(o: { companies?: string; db?: string; answers?: string } = {}): { forbidden: Forbidden; notes: string[] } {
  const f: Forbidden = { companies: [], strings: [] }, notes: string[] = [];
  const cj = o.companies ?? 'companies.json', dbp = o.db ?? process.env.JOB_RADAR_DB ?? 'data/jobs.db', ap = o.answers ?? 'answers.json';
  try { for (const c of JSON.parse(fs.readFileSync(cj, 'utf8')) as { name: string }[]) f.companies.push(c.name); } catch { notes.push(`${cj} not read`); }
  try { const db = new Database(dbp, { readonly: true, fileMustExist: true }); for (const r of db.prepare('SELECT DISTINCT company FROM jobs').all() as { company: string }[]) f.companies.push(r.company); db.close(); } catch { notes.push(`${dbp} not read (no local database here)`); }
  try {
    const a = JSON.parse(fs.readFileSync(ap, 'utf8'));
    for (const k of PERSONAL_KEYS) if (typeof a[k] === 'string') f.strings.push(a[k]);
    for (const v of Object.values(a.resumes ?? {})) if (typeof v === 'string') f.strings.push(v);
    for (const c of a.custom_answers ?? []) if (typeof c.answer === 'string' && c.answer.length >= 12) f.strings.push(c.answer);
    for (const v of Object.values(a.answers ?? {})) if (typeof v === 'string' && v.length >= 12) f.strings.push(v);
  } catch { notes.push(`${ap} not read`); }
  return { forbidden: f, notes };
}

export async function runLeakCheck(file: string, o: Parameters<typeof gatherForbidden>[0] = {}): Promise<string[]> {
  const { forbidden, notes } = gatherForbidden(o);
  console.log(`leak check against ${forbidden.companies.length} real company names and ${forbidden.strings.length} personal strings${notes.length ? ` (${notes.join('; ')})` : ''}`);
  return findLeaks(fs.readFileSync(file, 'utf8'), forbidden);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// DIRECTORY SCAN for the public export (npm run export:public). Same rule as above: personal values are read only to FORBID them and are never printed; a finding is `file:line  category`.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type Category = 'email' | 'phone' | 'personal string' | 'owner data' | 'real company name';
export const CATEGORIES: Category[] = ['email', 'phone', 'personal string', 'owner data', 'real company name'];

/** Everything the export must not contain. `nameParts` match as whole words (a name part such as "Ryan" must not trip on "Bryant"); everything else matches as a case-insensitive substring. */
export interface ExportForbidden { personal: string[]; nameParts: string[]; data: string[]; companies: string[]; notes: string[] }
export interface Finding { file: string; line: number | null; category: Category }
export interface ScanReport { filesScanned: number; findings: Finding[]; checked: Record<Category, number>; found: Record<Category, number>; notes: string[] }

const EMAIL_OK_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test)$/i;
/** Example domains only (RFC 2606: example.com/.org/.net, the .example and .test TLDs and their subdomains). */
export const isExampleEmail = (m: string) => EMAIL_OK_DOMAIN.test(m.slice(m.lastIndexOf('@') + 1));
/** Fictional numbers: the reserved 555-01xx range, plus any number whose area code or exchange is 555 (e.g. "(555) 123-4567", "415-555-1234"), which no real subscriber has. */
export const isFakePhone = (m: string) => /555[\s.-]?01\d\d/.test(m) || /^\W*(\+?1[\s.-]?)?\(?555\)?[\s.-]/.test(m) || /(^|\D)\d{3}[\s.-]555[\s.-]\d{4}/.test(m);
/** Role mailboxes (careers@, accommodations@, ...) that appear in captured public application forms. Allowed only inside fixture directories. */
export const isFixtureRoleEmail = (rel: string, m: string) => /^(tests\/)?fixtures\//.test(rel) && /^(accommodations?|careers?|jobs|recruiting|recruiters?|hr|people|talent|privacy|legal|support|help|info|press|security|noreply|no-reply|donotreply)$/i.test(m.slice(0, m.lastIndexOf('@')));

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz|sqlite|db)$/i;
/** Companies are forbidden in the demo (docs/) and in Markdown prose; code fixtures and companies.example.json may name public boards. */
const companyScoped = (rel: string) => rel.startsWith('docs/') || /\.md$/i.test(rel);

const lineOf = (text: string, idx: number) => { let n = 1; for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) n++; return n; };
const wordRe = (w: string) => new RegExp(`(^|[^a-z])${esc(w.toLowerCase())}($|[^a-z])`);
/** Company names in prose: whole word, `_` and digits count as word characters (ANTHROPIC_API_KEY is not "Anthropic"). Short single-word names (Scale, Ramp) are matched case-sensitively so that
 *  ordinary words ("a 0-100 scale") do not trip; longer or multi-word names are matched in any case. */
const companyMatcher = (name: string) => {
  const loose = name.length >= 8 || /\s/.test(name.trim());
  const re = new RegExp(`(^|[^A-Za-z0-9_])${esc(name)}($|[^A-Za-z0-9_])`, loose ? 'i' : '');
  return (text: string) => re.exec(text)?.index ?? -1;
};

function* walk(dir: string, base = dir): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base); else if (e.isFile()) yield path.relative(base, p).split(path.sep).join('/');
  }
}
/** Files of a tree, relative, forward slashes. Symlinks (e.g. a node_modules link used for --verify) are not followed. */
export const listFiles = (dir: string) => [...walk(dir)];

export function scanDir(dir: string, f: ExportForbidden): ScanReport {
  const clean = (a: string[], min: number) => [...new Set(a.map((x) => x.trim()).filter((x) => x.length >= min))];
  const personal = clean(f.personal, 4).map((s) => s.toLowerCase()), parts = clean(f.nameParts, 4), data = clean(f.data, 4).map((s) => s.toLowerCase()), companies = clean(f.companies, 3);
  const partRes = parts.map(wordRe), companyMs = companies.map(companyMatcher);
  const checked: Record<Category, number> = { email: 1, phone: 1, 'personal string': personal.length + parts.length, 'owner data': data.length, 'real company name': companies.length };
  const found: Record<Category, number> = { email: 0, phone: 0, 'personal string': 0, 'owner data': 0, 'real company name': 0 };
  const findings: Finding[] = [];
  const add = (file: string, line: number | null, category: Category) => { findings.push({ file, line, category }); found[category]++; };
  const files = listFiles(dir);
  for (const rel of files) {
    const abs = path.join(dir, rel), binary = BINARY_EXT.test(rel);
    const text = fs.readFileSync(abs).toString(binary ? 'latin1' : 'utf8');
    const lower = text.toLowerCase();
    const pos = (idx: number) => (binary ? null : lineOf(text, idx));
    for (const m of text.matchAll(new RegExp(EMAIL.source, 'g'))) if (!isExampleEmail(m[0]) && !isFixtureRoleEmail(rel, m[0])) add(rel, pos(m.index!), 'email');
    for (const m of text.matchAll(new RegExp(PHONE.source, 'g'))) if (!isFakePhone(m[0])) add(rel, pos(m.index!), 'phone');
    for (const s of personal) { const i = lower.indexOf(s); if (i !== -1) add(rel, pos(i), 'personal string'); }
    partRes.forEach((re) => { const m = re.exec(lower); if (m) add(rel, pos(m.index), 'personal string'); });
    for (const s of data) { const i = lower.indexOf(s); if (i !== -1) add(rel, pos(i), 'owner data'); }
    if (companyScoped(rel)) {
      const view = /\.html?$/i.test(rel) ? contentView(text) : text;   // for a page, only what a reader sees (see contentView)
      companyMs.forEach((match) => { const i = match(view); if (i !== -1) add(rel, binary || view !== text ? null : lineOf(text, i), 'real company name'); });
    }
  }
  return { filesScanned: files.length, findings, checked, found, notes: f.notes };
}
export const formatFinding = (x: Finding) => `${x.file}:${x.line ?? '-'}  ${x.category}`;
export function summarize(r: ScanReport): string {
  const rows = CATEGORIES.map((c) => `  ${c.padEnd(18)} ${String(r.checked[c]).padStart(6)} ${c === 'email' || c === 'phone' ? 'pattern ' : 'strings '}checked, ${r.found[c]} finding(s)`);
  return [`leak check over ${r.filesScanned} files:`, ...rows, ...r.notes.map((n) => `  skipped: ${n}`)].join('\n');
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));
function stringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => stringValues(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringValues(x, out));
  return out;
}
const git = (root: string, ...a: string[]) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

/** Gathers the forbidden set at check time from the owner's local files. Absent sources are skipped and named in `notes`. Values equal to something in a committed *.example.json are public by
 *  construction and are not forbidden (otherwise a generic profile field would flag the example profile). */
export function gatherExportForbidden(root: string = process.cwd()): ExportForbidden {
  const f: ExportForbidden = { personal: [], nameParts: [], data: [], companies: [], notes: [] };
  const rp = (...p: string[]) => path.join(root, ...p);
  const publicValues = new Set<string>();
  for (const ex of ['profile.example.json', 'answers.example.json', 'companies.example.json', 'job-radar.config.example.json', 'feeds.example.json']) {
    try { stringValues(readJson(rp(ex))).forEach((s) => publicValues.add(s.trim().toLowerCase())); } catch { /* no example here */ }
  }
  const publicText = [...publicValues].join('\n');
  const addPersonal = (s: string, min = 6) => { s = s.trim(); if (s.length >= min && !publicValues.has(s.toLowerCase()) && !publicText.includes(s.toLowerCase())) f.personal.push(s); };

  // companies and answers.json: the demo's own gathering
  const g = gatherForbidden({ companies: rp('companies.json'), db: process.env.JOB_RADAR_DB ?? rp('data/jobs.db'), answers: rp('answers.json') });
  f.companies.push(...g.forbidden.companies);
  g.forbidden.strings.forEach((s) => addPersonal(s, 4));
  if (g.notes.some((n) => /answers\.json/.test(n))) f.notes.push('answers.json not present (answers strings not checked)');
  if (g.notes.some((n) => /companies\.json/.test(n))) f.notes.push('companies.json not present (companies category uses the local DB only)');
  if (g.notes.some((n) => /jobs\.db/.test(n))) f.notes.push('data/jobs.db not present (DB companies not checked)');

  // profile.json
  try {
    const p = readJson(rp('profile.json'));
    if (typeof p.name === 'string') { addPersonal(p.name, 4); p.name.split(/[^A-Za-z]+/).filter((x: string) => x.length >= 4).forEach((x: string) => { if (!publicValues.has(x.toLowerCase())) f.nameParts.push(x); }); }
    for (const k of ['school', 'graduation']) if (typeof p[k] === 'string') addPersonal(p[k], 4);
    for (const k of ['business', 'businesses', 'business_names']) stringValues(p[k]).forEach((s) => addPersonal(s, 4));
    stringValues(Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_')))).forEach((s) => addPersonal(s, 6));   // "_note" keys are documentation, not data
  } catch { f.notes.push('profile.json not present (profile strings not checked)'); }

  // git identity and home path
  for (const k of ['user.name', 'user.email']) { const v = git(root, 'config', k); if (v) { addPersonal(v, 4); if (k === 'user.name') v.split(/[^A-Za-z]+/).filter((x) => x.length >= 4).forEach((x) => f.nameParts.push(x)); } }
  const home = os.homedir(); if (home && home !== '/' && home.length > 5) f.personal.push(home);

  // the owner's real data: applied / skip / queued jobs, mark_log, and the private eval set
  const dbp = process.env.JOB_RADAR_DB ?? rp('data/jobs.db');
  try {
    const db = new Database(dbp, { readonly: true, fileMustExist: true });
    const keys = new Set<string>();
    const grab = (sql: string) => { try { for (const r of db.prepare(sql).all() as { key: string }[]) if (r.key) keys.add(r.key); } catch { /* table missing */ } };
    grab("SELECT key FROM jobs WHERE status IN ('applied','skip','queued')"); grab('SELECT key FROM prep_queue'); grab('SELECT key FROM mark_log');
    db.close();
    for (const k of keys) { if (k.length >= 6) f.data.push(k); const id = k.includes(':') ? k.slice(k.indexOf(':') + 1) : ''; if (id.length >= 6) f.data.push(id); }
  } catch { f.notes.push('data/jobs.db not present (applied/skip/queued keys not checked)'); }
  const priv = rp('eval/private');
  if (fs.existsSync(priv)) {
    for (const fn of fs.readdirSync(priv).filter((x) => x.endsWith('.jsonl'))) for (const line of fs.readFileSync(path.join(priv, fn), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line); const k: string | undefined = r.key;
        if (k && k.length >= 6) f.data.push(k); const id = k && k.includes(':') ? k.slice(k.indexOf(':') + 1) : r.snapshot?.id; if (typeof id === 'string' && id.length >= 6) f.data.push(id);
        const t = r.snapshot?.title; if (typeof t === 'string' && t.length >= 25 && t.trim().split(/\s+/).length >= 5) f.data.push(t);   // distinctive: generic 3-4 word titles ("Software Engineer, Backend") are not
        const c = r.snapshot?.company; if (typeof c === 'string') f.companies.push(c);
      } catch { /* not a record */ }
    }
  } else f.notes.push('eval/private not present (private eval ids and titles not checked)');
  f.notes = [...new Set(f.notes)];
  return f;
}

if (process.argv[1]?.endsWith('leakcheck.ts')) {
  const leaks = await runLeakCheck(process.argv[2] ?? 'docs/index.html');
  if (leaks.length) { console.error(leaks.map((l) => `  - ${l}`).join('\n')); process.exit(1); }
  console.log('no leaks');
}
