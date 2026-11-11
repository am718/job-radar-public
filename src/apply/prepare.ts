import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type Database from 'better-sqlite3';
import { USER_AGENT } from '../config.js';
import { loadCompanies } from '../userconfig.js';
import { openDb } from '../store.js';
import { loadProfile, cacheVersion, type LlmFn } from '../scoring/scorer.js';
import { BANDS } from '../scoring/prompts.js';
import { markJob } from '../marking.js';
import { titleTrack } from '../prefilter.js';
import { loadAnswers, type Answers } from './answers.js';
import { installGuards, blockedSubmitCount, type Guards } from './guard.js';
import { handoff } from './handoff.js';
import { detectBlocker, type Blocker } from './blockers.js';
import { classifyBlocked } from './protection.js';
import { isProtected, recordSite, siteStatus } from './sites.js';
import { preflightCompanies, type GetFn } from './preflight.js';
import { prepareByHand, renderByHand } from './byhand.js';
import { applyUrl, canonicalGreenhouseUrl, waitForForm } from './ats.js';
import { prefill, completeness, missingChecks, type FillReport } from './fill.js';
import { tailoredNote } from './note.js';
import { coverLetter, writeLetterFiles } from './coverletter.js';
import { backfillQueue, recordPrepared, remainingToday, dailyCap, etDate, preparedOn } from './queue.js';
import { postedInfo } from '../fresh.js';
import { rankScore } from '../rank.js';
import type { Ats } from '../types.js';

export interface PrepareResult {
  key: string; url: string; track: 'A' | 'B'; blocker: Blocker | null; report: FillReport | null; notePath: string | null; noteCached: boolean | null; noteWhy?: string;
  blockedSubmits: number; blockedRequests: string[]; closed: Promise<void>; summary: string;
  letterPdf: string | null; letterMd: string | null; letterWhy?: string; page: Page | null; company: string; title: string;
  complete: boolean; screenshot: string | null; handedOff?: boolean; guards?: Guards;   // complete = name, email, phone, resume and cover letter all filled (or legitimately absent/skipped)
}
const PREPARED_DEFAULT = process.env.JOB_RADAR_PREPARED ?? 'prepared';
export class RefusedError extends Error {}

export function findJob(db: Database.Database, id: string) {
  const row = (id.includes(':') ? db.prepare('SELECT * FROM jobs WHERE key=?').all(id) : db.prepare('SELECT * FROM jobs WHERE id=?').all(id)) as any[];
  if (row.length !== 1) throw new RefusedError(row.length ? `id "${id}" is ambiguous; use source:id` : `no job "${id}"`);
  return row[0];
}

function renderSummary(r: Pick<PrepareResult, 'key' | 'url' | 'track' | 'blocker' | 'report' | 'notePath' | 'blockedSubmits' | 'letterMd' | 'letterPdf'> & { letterWhy?: string; screenshot?: string | null }, job: any): string {
  const L: string[] = [`=== ${job.company} - ${job.title}`, `    ${r.key}   track ${r.track}   ${r.url}`];
  if (r.blocker) { L.push('', `STOPPED: ${r.blocker.kind} (${r.blocker.detail}). Nothing was filled. Open the page yourself.`); return L.join('\n'); }
  const rep = r.report!;
  const miss = missingChecks(rep);
  if (miss.length) L.push('', '!!!!!!!! NOT COMPLETE: ' + miss.map((m) => `${m.item.toUpperCase()} MISSING`).join(', ') + ' !!!!!!!!', ...miss.map((m) => `!! ${m.item}: ${m.detail}`), '!! Do not rely on this tab; fix the cause above (or fill those fields by hand) before submitting.');
  L.push('', 'VERIFY (re-read from the live form after filling):', ...rep.checks.map((c) => `  ${c.item.padEnd(13)} ${c.status === 'filled' ? 'filled' : c.status === 'MISSING' ? 'MISSING' : c.status}  - ${c.detail}`));
  if (rep.unregistered?.length) L.push('', `NOT FILLED (the field shows text but the form's own state rejects it) - ${rep.unregistered.length}:`, ...rep.unregistered.map((u) => `  !! ${u.field}: ${u.why}`));
  if (rep.reapplied.length) L.push('', `NOTE: the page cleared ${rep.reapplied.length} field(s) after they were filled (some forms reset when a dropdown such as the phone Country changes); they were filled again and re-checked: ${rep.reapplied.join('; ')}`);
  L.push('', `FILLED (${rep.filled.length}):`, ...rep.filled.map((f) => `  + ${f.field}: ${f.value}`));
  const tag: Record<string, string> = { empty: 'you left it empty', legal: 'legal/attestation rule', custom: 'custom question', matcher: 'MATCHER MISSED' };
  L.push('', `LEFT BLANK for you (${rep.blank.length}):`, ...(rep.blank.length ? rep.blank.map((b) => `  - ${b.field}  [${tag[b.cause]}: ${b.reason}]`) : ['  (none)']));
  L.push('', `UNCERTAIN, please check (${rep.uncertain.length}):`, ...(rep.uncertain.length ? rep.uncertain.map((u) => `  ? ${u.field}  [${u.why}]`) : ['  (none)']));
  L.push('', completeness(rep, r.letterWhy));
  const need = rep.blank.filter((b) => b.cause === 'empty' || (b.cause === 'legal' && /needs your answer|no exact answer/.test(b.reason)));
  if (need.length) L.push('NEEDS YOUR ANSWER (add to answers.json; `npm run answers:check` lists them): ' + need.map((b) => `${b.required ? '*' : ''}${b.field}`).join('; '));
  if (r.screenshot) L.push(`Screenshot of the filled form: ${r.screenshot}`);
  L.push(rep.letterStatus === 'attached' ? `Cover letter: PDF attached from ${r.letterPdf}` : rep.letterStatus === 'pasted' ? `Cover letter: text pasted into the form (PDF also saved at ${r.letterPdf})` : rep.letterStatus === 'saved only' ? `Cover letter: the form has no cover-letter upload or text box; saved only: ${r.letterMd} and ${r.letterPdf}` : 'Cover letter: none generated');
  L.push('', rep.notePlacedInForm ? 'Tailored note: placed in the form\'s cover-letter / "why" field and' : 'Tailored note: the form has no cover-letter / "why" field;', `  saved to ${r.notePath ?? '(no note generated)'}`);
  L.push('', `Submit was NOT clicked (blocked submit attempts: ${r.blockedSubmits}). Review the window, then submit yourself. After submitting run: npm run mark -- ${r.key} applied`);
  return L.join('\n');
}

/** When the ATS itself answers YOUR submit with a success (seen passively on the network, nothing is clicked or read from the page), the job is marked applied, same as `npm run mark`. */
export const autoMarker = (db: Database.Database, log: (s: string) => void) => (key: string, evidence: string) => {
  try { const r = markJob(db, key, 'applied', 'auto'); log(`\u2713 [${key}] your submit went through (${evidence}); ${r.changed ? 'marked applied' : 'already marked applied'} automatically.`); }
  catch (e) { log(`(could not auto-mark ${key}: ${(e as Error).message}; run: npm run mark -- ${key} applied)`); }
};

/** HANDOFF for one prepared tab: only if it is fully prepared and verified (complete, no blocker, screenshot done). Otherwise the guard STAYS and the tab is not left half-filled with the guard lifted. */
export async function handOffTab(r: PrepareResult, log: (s: string) => void, keepRoute = false, onSubmitted?: (key: string, evidence: string) => void): Promise<void> {
  if (!r.page || !r.guards) return;
  if (r.blocker || !r.report || !r.complete) { log(`Handoff withheld for ${r.key}: ${r.blocker ? `stopped by a blocker (${r.blocker.kind})` : 'NOT COMPLETE (an essential field is MISSING)'}. The network guard stays ON for this tab, so a submit here would be dropped: finish this one in your normal browser from the apply link, or fix the answer and re-run.`); return; }
  await handoff(r.page, r.guards, { key: r.key, log, keepRoute, onSubmitted }); r.handedOff = true;
}

export async function prepareJob(o: {
  db: Database.Database; id: string; answers: Answers; llm: LlmFn | null; headless?: boolean; urlOverride?: string; force?: boolean; noNote?: boolean;
  browser?: Browser; context?: BrowserContext; noLetter?: boolean; preparedDir?: string; log?: (s: string) => void; llmWhy?: string; noShot?: boolean;
  handoff?: boolean;   // single-job runs: once verified and photographed, lift the guards for this tab and stop touching it (batch runs hand off in prepareBatch)
  onPhase?: (phase: 'opening' | 'filling' | 'verifying', detail?: string) => void;   // optional progress hook (the dashboard); never changes behaviour
}): Promise<PrepareResult> {
  const log = o.log ?? console.log;
  const job = findJob(o.db, o.id);
  if (['applied', 'skip'].includes(job.status) && !o.force) throw new RefusedError(`${job.key} is marked ${job.status}; not preparing it (use --force to override)`);
  const profile = loadProfile().summary;
  const scoreRow = o.db.prepare('SELECT json FROM scores WHERE key=? AND prompt_version=?').get(job.key, cacheVersion('v3')) as { json: string } | undefined;
  const track: 'A' | 'B' = (scoreRow ? JSON.parse(scoreRow.json).track : titleTrack(job.title)) ?? 'A';   // resume A or B follows the job's track
  const resumePath = o.answers.resumes?.[track] ?? null;

  o.onPhase?.('opening', 'writing note/letter and loading the form');
  // 1) tailored note (one Sonnet call, cached; description is untrusted; facts only from profile.json)
  let note: string | null = null, noteCached: boolean | null = null, noteWhy: string | undefined;
  if (!o.noNote) { const n = await tailoredNote(o.db, job, profile, o.llm, o.answers.name ?? undefined); note = n.note; noteCached = n.cached; noteWhy = n.why; }

  // 1b) cover letter (180-220 words, same fact validator; PDF named <INITIALS>_Cover_Letter_<Company>.pdf next to the markdown copy)
  let letter: string | null = null, letterPdf: string | null = null, letterMd: string | null = null, letterWhy: string | undefined;
  if (!o.noLetter) {
    const l = await coverLetter(o.db, job, profile, o.llm, o.answers.name ?? undefined);
    letter = l.letter; letterWhy = l.why === 'no LLM configured' && o.llmWhy ? o.llmWhy : l.why;
    if (letter) {
      const contact = [o.answers.email, o.answers.phone, o.answers.linkedin].filter((x) => x && !/^REPLACE/i.test(x)).join('  |  ');
      const f = await writeLetterFiles(o.preparedDir ?? PREPARED_DEFAULT, job, letter, { name: o.answers.name ?? '', contact });
      letterPdf = f.pdf; letterMd = f.md;
    }
  }

  // 2) open the form in a visible browser (one job, one navigation), guards installed before anything loads
  const boardSlug = (() => { try { return (loadCompanies()).find((c) => c.ats === 'greenhouse' && c.name === job.company)?.slug ?? null; } catch { return null; } })();
  const url = o.urlOverride ?? (job.source === 'greenhouse' ? canonicalGreenhouseUrl(job.url, String(job.id), boardSlug) : applyUrl(job.source as Ats, job.url));
  const own = !o.browser && !o.context;
  const browser = o.context ? o.context.browser()! : (o.browser ?? await chromium.launch({ headless: o.headless ?? false }));
  let guards: Guards;
  let ctx: BrowserContext;
  if (o.context) { ctx = o.context; guards = (o.context as any).__jrGuards; }                  // batch mode: one window, guards installed once
  else { ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: null }); guards = await installGuards(ctx, { allowOnly: url.startsWith('file:') ? (u) => u.protocol === 'file:' || u.protocol === 'data:' : undefined }); }
  const page: Page = await ctx.newPage();                                                                       // a new TAB in the same window
  const closed = new Promise<void>((res) => { page.on('close', () => res()); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForForm(page, job.source as Ats);
  o.onPhase?.('filling');

  let blocker = await detectBlocker(page), report: FillReport | null = null;
  if (!blocker && (await page.locator('input:visible, textarea:visible').count()) === 0 && guards.blocked.some((b) => /awswaf|captcha|challenge|datadome|perimeterx|cloudflare/i.test(b))) blocker = { kind: 'captcha', detail: `the page is behind a bot-protection challenge (${guards.blocked.find((b) => /awswaf|captcha|challenge|datadome|perimeterx|cloudflare/i.test(b))!.split(' ')[1]?.slice(0, 60)}) and shows no form; this tool does not try to get past it. Open the link yourself` };
  if (blocker && !o.urlOverride?.startsWith('file:')) {   // remember it: this company's apply page is not fillable, so it is not picked again until the status expires (14 days)
    const pv = blocker.kind === 'closed' ? null : classifyBlocked(blocker.kind, blocker.detail, guards.blocked);
    if (pv) { recordSite(o.db, { company: job.company, ats: job.source, status: 'protected', vendor: pv.vendor, reason: pv.reason, source: 'blocker' }); log(`(recorded in apply_sites: ${job.company} is protected - ${pv.vendor}; it will not be auto-picked again until the status expires)`); }
  }
  if (!blocker) report = await prefill(page, o.answers, { resumePath, track, note, letter, letterPdf, letterWhy: o.noLetter ? 'skipped by --no-letter' : letterWhy, letterSkipped: !!o.noLetter }, { exists: (p) => fs.existsSync(p) });
  o.onPhase?.('verifying');
  const blockedSubmits = await blockedSubmitCount(page);

  // 3) notes + summary files
  fs.mkdirSync(o.preparedDir ?? PREPARED_DEFAULT, { recursive: true });
  const notePath = note ? path.join(o.preparedDir ?? PREPARED_DEFAULT, `${job.source}-${job.id}.md`) : null;
  // full-page screenshot of the prepared form, so you can see the result
  let screenshot: string | null = null;
  if (report && !o.noShot) { try { screenshot = path.resolve(o.preparedDir ?? PREPARED_DEFAULT, `${job.source}-${job.id}-form.png`); await page.screenshot({ path: screenshot, fullPage: true, timeout: 20000 }); } catch (e) { screenshot = null; log(`(screenshot failed: ${(e as Error).message.split('\n')[0]})`); } }
  const complete = !!report && missingChecks(report).length === 0;
  const partial = { key: job.key, url, track, blocker, report, notePath, blockedSubmits, letterMd, letterPdf, letterWhy: o.noLetter ? 'skipped by --no-letter' : letterWhy, screenshot };
  const summary = renderSummary(partial, job);
  if (notePath) fs.writeFileSync(notePath, `# ${job.company} - ${job.title}\n\n${url}\n\n## Tailored note (3 sentences; facts only from profile.json)\n\n${note}\n\n## Prefill summary\n\n\`\`\`\n${summary}\n\`\`\`\n`);
  log(summary);
  if (report) { // remember which questions keep coming up blank (feeds `npm run answers:todo`)
    const lines = report.blank.map((b) => JSON.stringify({ ts: new Date().toISOString(), job: job.key, company: job.company, field: b.field, cause: b.cause, required: !!b.required, reason: b.reason })).join('\n');
    if (lines) fs.appendFileSync(path.join(o.preparedDir ?? PREPARED_DEFAULT, 'blank-questions.jsonl'), lines + '\n');
  }
  if (noteWhy && !note) log(`(no tailored note: ${noteWhy})`);
  if (letterWhy && !letter) log(`(no cover letter: ${letterWhy})`);
  if (report && !o.urlOverride?.startsWith('file:')) recordPrepared(o.db, job.key, complete, { note: notePath ? path.resolve(notePath) : null, letterPdf: letterPdf ? path.resolve(letterPdf) : null, letterMd: letterMd ? path.resolve(letterMd) : null, screenshot });   // joins the review queue; not picked again until marked applied / skip
  const result: PrepareResult = { ...partial, noteCached, noteWhy, letterWhy, complete, blockedRequests: guards.blocked, closed, summary, page, company: job.company, title: job.title };
  if (own) result.closed = Promise.race([closed, new Promise<void>((res) => browser.on('disconnected', () => res()))]);
  result.guards = guards;
  if (o.handoff && !o.context) await handOffTab(result, log, false, autoMarker(o.db, log));   // LAST thing done to this page; batch runs do it in prepareBatch once every tab is ready
  return result;
}

/** Parse argv: value options are --url --answers --top; everything else not starting with "--" is the job id. */
export function parseArgs(a: string[]) {
  const valueOpts = new Set(['--url', '--answers', '--top', '--cap', '--parallel', '--min-score']);
  const flags = new Set<string>(); const vals: Record<string, string | undefined> = {}; const pos: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (valueOpts.has(a[i])) {
      // every value option is read the same way: vals[name] is the value, or '' when none was given. --top only takes a plain number, so `--top lever:abc` leaves the id alone.
      const nxt = a[i + 1], takes = nxt !== undefined && !nxt.startsWith('--') && (a[i] !== '--top' || /^\d+$/.test(nxt));
      if (takes) { vals[a[i].slice(2)] = nxt; i++; } else vals[a[i].slice(2)] = '';
      flags.add(a[i].slice(2));
    }
    else if (a[i].startsWith('--')) flags.add(a[i].slice(2)); else pos.push(a[i]);
  }
  return { flags, vals, id: pos[0] };
}

export interface TopPick { key: string; company: string; source: string; id: string; url: string; score: number; fresh: boolean; rank: number }
/** All unapplied scored jobs of the digest day, best first. Order: LLM score, then FRESH (posted within 7 days) first at equal score, then the digest ranking score. */
export function rankedJobs(db: Database.Database, date: string, asOf: string = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })): TopPick[] {
  const rows = db.prepare("SELECT j.*, s.json sj FROM jobs j JOIN scores s ON s.key=j.key AND s.prompt_version=? WHERE j.digest_date=? AND j.filter_reason IS NULL AND j.status NOT IN ('applied','skip') AND j.source IN ('greenhouse','lever','ashby') AND j.key NOT IN (SELECT key FROM prep_queue)").all(cacheVersion('v3'), date) as any[];
  return rows.map((r) => {
    const score = JSON.parse(r.sj).score as number, p = postedInfo(r, asOf);
    return { key: r.key, company: r.company, source: r.source, id: String(r.id), url: r.url, score, fresh: p.fresh, rank: rankScore(score, r.tier, (r.pay_flag ?? 'pay unlisted') as any, (r.arrangement ?? 'unknown') as any, r.office_days ?? null, p.fresh) };
  }).sort((x, y) => y.score - x.score || Number(y.fresh) - Number(x.fresh) || y.rank - x.rank);
}
/** The n best jobs whose apply page the tool can fill. Jobs of a company marked protected in apply_sites (or in known-protected.json) are skipped and the next-best job takes the slot; includeProtected overrides. */
export function pickTop(db: Database.Database, date: string, n: number, asOf?: string, o: { includeProtected?: boolean; minScore?: number } = {}): TopPick[] {
  const all = rankedJobs(db, date, asOf).filter((p) => p.score >= (o.minScore ?? 0));   // below minScore the job is a poor fit (missing a hard requirement or another field): never opened
  return (o.includeProtected ? all : all.filter((p) => !isProtected(db, p.company))).slice(0, n);
}
/** Lowest LLM score a job needs before `--top` opens it. 40 = the start of the "med" band (a stretch the candidate would take); below it the scorer says a hard requirement is missing or the field is different. */
export const DEFAULT_MIN_SCORE = BANDS.med;
export const minScore = (env: NodeJS.ProcessEnv = process.env) => { const v = Number(env.JOB_RADAR_MIN_SCORE); return env.JOB_RADAR_MIN_SCORE !== undefined && Number.isFinite(v) && v >= 0 && v <= 100 ? v : DEFAULT_MIN_SCORE; };
/** Like pickTop, but first preflights (read-only GET, one per company) the companies of the candidates whose status is not fresh, so a newly protected company is skipped before a slot is spent on it. */
export async function pickFillable(db: Database.Database, date: string, n: number, o: { includeProtected?: boolean; minScore?: number; preflight?: boolean; get?: GetFn; gapMs?: number; slugOf?: (c: string) => string | null; log?: (s: string) => void; asOf?: string } = {}): Promise<{ picks: TopPick[]; skipped: TopPick[] }> {
  const tried = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const picks = pickTop(db, date, n, o.asOf, { includeProtected: o.includeProtected, minScore: o.minScore });
    const need = o.includeProtected || o.preflight === false ? [] : picks.filter((p) => !siteStatus(db, p.company).fresh && !tried.has(p.company.toLowerCase()));
    if (!need.length) {
      const all = rankedJobs(db, date, o.asOf).filter((p) => p.score >= (o.minScore ?? 0)), last = picks.length ? all.findIndex((p) => p.key === picks[picks.length - 1].key) : all.length;
      return { picks, skipped: o.includeProtected ? [] : all.slice(0, last).filter((p) => isProtected(db, p.company)) };
    }
    need.forEach((p) => tried.add(p.company.toLowerCase()));
    await preflightCompanies(db, need, { get: o.get, gapMs: o.gapMs, slugOf: o.slugOf, log: o.log });
  }
  return { picks: pickTop(db, date, n, o.asOf, { includeProtected: o.includeProtected, minScore: o.minScore }), skipped: [] };
}

export interface BatchResult { results: (PrepareResult | { key: string; error: string })[]; checklist: string; closed: Promise<void>; browser: Browser }

/** LIVE LIST: "ready to review: 4/10". One line per change (append-only, so it reads the same in a terminal, a pipe or a log). */
export function liveBoard(total: number, log: (s: string) => void) {
  const st = { ready: 0, withheld: 0, failed: 0, working: 0 };
  const head = () => `ready to review: ${st.ready}/${total}   (working ${st.working}, needs you ${st.withheld}, failed ${st.failed})`;
  return {
    st,
    start(label: string) { st.working++; log(`[${head()}]  working: ${label}`); },
    ready(label: string) { st.working--; st.ready++; log(`[${head()}]  READY (handed off, review and submit): ${label}`); },
    withheld(label: string, why: string) { st.working--; st.withheld++; log(`[${head()}]  NEEDS YOU (not handed off: ${why}): ${label}`); },
    failed(label: string, why: string) { st.working--; st.failed++; log(`[${head()}]  FAILED: ${label}: ${why}`); },
  };
}

/** Prepares the jobs in the BACKGROUND: up to `parallel` tabs at once in ONE window. Each tab is HANDED OFF the moment it passes VERIFY (complete, no blocker, screenshot taken); tabs that are not complete are not
 *  handed off and keep the guard. A live "ready to review: k/N" line is printed on every change, and one checklist at the end. Never clicks submit. */
export async function prepareBatch(o: {
  db: Database.Database; ids: string[]; answers: Answers; llm: LlmFn | null; headless?: boolean; browser?: Browser; urlFor?: (key: string) => string | undefined; llmWhy?: string;
  noNote?: boolean; noLetter?: boolean; preparedDir?: string; log?: (s: string) => void; force?: boolean; handoff?: boolean; parallel?: number;
  onPhase?: (key: string, phase: 'opening' | 'filling' | 'verifying', detail?: string) => void;   // optional progress hooks (the dashboard)
  onResult?: (r: PrepareResult | { key: string; error: string }) => void;   // called per job as soon as it is handed off / withheld / failed
}): Promise<BatchResult> {
  const log = o.log ?? console.log;
  const browser = o.browser ?? await chromium.launch({ headless: o.headless ?? false });
  const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: null });
  const anyFile = o.ids.some((k) => o.urlFor?.(k)?.startsWith('file:'));
  const batchGuards = await installGuards(ctx, { allowOnly: anyFile ? (u) => u.protocol === 'file:' || u.protocol === 'data:' : undefined });
  const results: BatchResult['results'] = new Array(o.ids.length);
  const board = liveBoard(o.ids.length, log);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++; if (i >= o.ids.length) return;
      const id = o.ids[i]; board.start(id);
      try {
        const r = await prepareJob({ db: o.db, id, answers: o.answers, llm: o.llm, context: ctx, urlOverride: o.urlFor?.(id), noNote: o.noNote, noLetter: o.noLetter, preparedDir: o.preparedDir, log: () => {}, force: o.force, llmWhy: o.llmWhy, onPhase: o.onPhase ? (p, d) => o.onPhase!(id, p, d) : undefined });
        results[i] = r; const label = `${r.company} - ${r.title} (${r.key})`;
        if (o.handoff) { r.guards = batchGuards; await handOffTab(r, log, true, autoMarker(o.db, log)); }   // as soon as THIS tab is verified; the route stays so tabs still being filled remain guarded
        if (r.handedOff) board.ready(label);
        else board.withheld(label, r.blocker ? `blocker: ${r.blocker.kind}` : r.complete ? 'handoff off' : `NOT COMPLETE: ${missingChecks(r.report!).map((m) => m.item).join(', ')}`);
        try { o.onResult?.(r); } catch { /* a hook must not break the run */ }
      } catch (e) { results[i] = { key: id, error: (e as Error).message }; board.failed(id, (e as Error).message); try { o.onResult?.(results[i]); } catch { /* ignore */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? 3, o.ids.length)) }, worker));
  const first = results.find((r): r is PrepareResult => 'page' in r && !!r.page);
  await first?.page?.bringToFront().catch(() => {});
  const L: string[] = ['', `=== BATCH CHECKLIST: ${results.length} job(s), one tab each in ONE window. Nothing was submitted; you click submit yourself.`];
  results.forEach((r, i) => {
    if ('error' in r) { L.push(`Tab ${i + 1}: ${r.key}  NOT PREPARED: ${r.error}`); return; }
    const rep = r.report;
    L.push(`Tab ${i + 1}: ${r.company} - ${r.title}  (${r.key}, track ${r.track})`);
    if (r.blocker) L.push(`   BLOCKER: ${r.blocker.kind} (${r.blocker.detail}). Nothing filled in this tab; do it by hand.`);
    else L.push(`   filled ${rep!.filled.length} | blank ${rep!.blank.length} (empty ${rep!.blank.filter((b) => b.cause === 'empty').length}, legal ${rep!.blank.filter((b) => b.cause === 'legal').length}, custom ${rep!.blank.filter((b) => b.cause === 'custom').length}, matcher ${rep!.blank.filter((b) => b.cause === 'matcher').length}) | uncertain ${rep!.uncertain.length} | cover letter: ${rep!.letterStatus === 'none' ? `none generated${r.letterWhy ? ` (${r.letterWhy})` : ''}` : rep!.letterStatus} | blockers: none`);
    if (rep) L.push(`   VERIFY: ${rep.checks.map((c) => `${c.item} ${c.status === 'filled' ? 'filled' : c.status === 'MISSING' ? 'MISSING' : c.status}`).join(' | ')}${r.complete ? '' : '   <-- NOT COMPLETE: ' + missingChecks(rep).map((m) => `${m.item}: ${m.detail}`).join(' ; ')}`);
    if (r.screenshot) L.push(`   screenshot: ${r.screenshot}`);
    L.push(`   details: ${r.notePath ?? '(no note file)'}`);
  });
  L.push('', 'After you submit a job yourself, run: npm run mark -- <source:id> applied  (this tool never marks anything).');
  const checklist = L.join('\n'); log(checklist);
  return { results, checklist, browser, closed: new Promise<void>((res) => browser.on('disconnected', () => res())) };
}

export const USAGE = 'usage: npm run prepare -- <source:id> | --top [N=5]   [--no-note] [--no-letter] [--force] [--headless] [--include-protected] [--no-preflight] [--cap N] [--parallel K] [--min-score N=40] [--url <mock form url>] [--answers <file>]\n       (daily cap: JOB_RADAR_DAILY_CAP or --cap, default 10 prepared per day; prepared jobs wait in `npm run queue` until marked applied / skip)';
/** `prepare` is also an npm LIFECYCLE name: npm runs it on `npm install` / `npm ci` (and rebuild/pack/publish). Skip ONLY then; `npm run prepare` has npm_command=run-script and must run. */
export function isInstallLifecycle(env: NodeJS.ProcessEnv): boolean {
  return env.npm_lifecycle_event === 'prepare' && ['install', 'ci', 'rebuild', 'pack', 'publish'].includes(env.npm_command ?? '');
}

async function main() {
  if (isInstallLifecycle(process.env)) { console.log(`prepare: skipped, this is the npm "${process.env.npm_command}" lifecycle hook, not a job-prepare run (use: npm run prepare -- --top 5)`); process.exit(0); }
  const a = process.argv.slice(2);
  const parsed = parseArgs(a);
  const opt = (n: string) => parsed.vals[n] || undefined;
  if (parsed.vals.top === undefined && !parsed.id) { console.error(USAGE); process.exit(1); }   // usage first: no db or answers.json needed to print it
  const db = openDb();
  const answers = loadAnswers(opt('answers') ?? 'answers.json');
  let llm: LlmFn | null = null, llmWhy: string | undefined;
  if (!parsed.flags.has('no-note') || !parsed.flags.has('no-letter')) {   // the letter needs the model even when --no-note is given
    try { const { budgetedLlm } = await import('../spend.js'); llm = budgetedLlm('APPLY', 'apply note+letter', { maxTokens: 2500, noThinking: true }); /* otherwise the model spends the whole budget thinking and returns no text */ }
    catch (e) { llmWhy = (e as Error).message; console.error(`!! No model available, so NO cover letter or note will be generated: ${llmWhy}`); }   // the form is still filled; the letter is reported MISSING with this reason
  }
  const common = { handoff: true, headless: parsed.flags.has('headless'), db, answers, llm, llmWhy, force: parsed.flags.has('force'), noNote: parsed.flags.has('no-note'), urlOverride: opt('url') };
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const waits: Promise<void>[] = [];
  let byHandText = '';
  if (parsed.vals.top !== undefined) {
    const n = parsed.vals.top === '' ? 5 : Number(parsed.vals.top);
    if (!Number.isInteger(n) || n < 1) { console.error(`--top needs a positive whole number, got "${parsed.vals.top}"\n${USAGE}`); process.exit(1); }
    const imported = backfillQueue(db, PREPARED_DEFAULT); if (imported) console.log(`(imported ${imported} job(s) prepared before the queue existed, from ${PREPARED_DEFAULT}/; they wait in the queue and are not picked again)`);
    const cap = opt('cap') ? Number(opt('cap')) : dailyCap();
    if (!Number.isInteger(cap) || cap < 1) { console.error(`--cap needs a positive whole number, got "${opt('cap')}"`); process.exit(1); }
    const left = remainingToday(db, etDate(), cap);
    if (left === 0) { console.log(`Daily cap reached: ${preparedOn(db, etDate())} prepared today (cap ${cap}). Review them with \`npm run queue\` and mark them applied or skip; raise it with --cap or JOB_RADAR_DAILY_CAP.`); return; }
    const want = Math.min(n, left);
    if (want < n) console.log(`Daily cap ${cap}: ${preparedOn(db, etDate())} already prepared today, so preparing ${want} instead of ${n}.`);
    let day = date;
    if (!db.prepare('SELECT 1 FROM jobs WHERE digest_date=?').get(day)) { const last = db.prepare('SELECT max(digest_date) d FROM jobs').get() as { d: string | null }; if (last.d) { console.log(`no digest rows for ${day}; using the latest digest day ${last.d}`); day = last.d; } }
    const slugOf = (c: string) => { try { return (loadCompanies()).find((x) => x.ats === 'greenhouse' && x.name === c)?.slug ?? null; } catch { return null; } };
    const floor = opt('min-score') !== undefined ? Number(opt('min-score')) : minScore();
    if (!Number.isFinite(floor) || floor < 0 || floor > 100) { console.error(`--min-score needs a number from 0 to 100, got "${opt('min-score')}"`); process.exit(1); }
    const { picks, skipped } = await pickFillable(db, day, want, { minScore: floor, includeProtected: parsed.flags.has('include-protected'), preflight: !parsed.flags.has('no-preflight') && !common.urlOverride?.startsWith('file:'), slugOf, log: (s) => console.log(`  ${s}`) });
    const below = rankedJobs(db, day).filter((p) => p.score < floor).length;
    if (!picks.length) { console.log(`no unapplied, fillable scored jobs at fit ${floor}+ in the digest (${day})${below ? `; ${below} lower-fit job(s) were left alone (--min-score to change)` : ''}`); }
    else if (picks.length < want) console.log(`Only ${picks.length} job(s) reach the minimum fit of ${floor}; ${below} lower-fit job(s) were left alone rather than opening jobs you are unlikely to qualify for (lower it with --min-score N).`);
    if (skipped.length) {
      console.log(`Skipping ${skipped.length} higher-ranked job(s) at bot-protected companies (use --include-protected to force): ${[...new Set(skipped.map((p) => p.company))].join(', ')}`);
      const items = [];   // everything prepared for pasting, no form opened
      for (const p of skipped.slice(0, 5)) { try { items.push(await prepareByHand(db, p.key, answers, llm, { llmWhy, noteToo: !common.noNote })); } catch (e) { console.log(`(by-hand prep failed for ${p.key}: ${(e as Error).message})`); } }
      byHandText = renderByHand(items);
    }
    if (!picks.length) { if (byHandText) console.log(byHandText); return; }
    console.log(`Preparing the ${picks.length} highest-fit unapplied jobs the tool can fill (fresh first at equal fit):`); picks.forEach((p, i) => console.log(`  ${i + 1}. ${p.key}  score ${p.score}${p.fresh ? '  (posted in the last 7 days)' : ''}`));
    const b = await prepareBatch({ db, ids: picks.map((p) => p.key), answers, llm, headless: common.headless, handoff: true, parallel: opt('parallel') ? Number(opt('parallel')) : 3, noNote: common.noNote, noLetter: parsed.flags.has('no-letter'), force: common.force, llmWhy, urlFor: common.urlOverride ? () => common.urlOverride : undefined });   // --url (a local mock form) applies to every job in the batch
    waits.push(b.closed);
    if (byHandText) console.log(byHandText);
    if (b.results.some((r) => !('error' in r) && !r.complete) || b.results.some((r) => 'error' in r)) { process.exitCode = 2; console.log('\n!! At least one tab is NOT COMPLETE (see NOT COMPLETE / NOT PREPARED lines above). Exit code 2.'); }
  } else {
    const id = parsed.id;
    if (!id) { console.error(USAGE); process.exit(1); }
    const r = await prepareJob({ ...common, id, noLetter: parsed.flags.has('no-letter') }); waits.push(r.closed);
    if (!r.complete) { process.exitCode = 2; console.log('\n!! NOT COMPLETE: the essentials listed above are MISSING. Exit code 2.'); }
  }
  if (parsed.flags.has('headless')) { console.log('\n(headless test run: closing)'); process.exit(process.exitCode ?? 0); }
  console.log('\nWindow(s) left open for you. Fully prepared tabs are HANDED OFF: the network guard is lifted and the tool no longer touches them; you click Submit. Close the window (or press Ctrl+C) when done. This tool never submits and never marks jobs applied.');
  await Promise.all(waits);
}
if (process.argv[1]?.endsWith('prepare.ts')) main().catch((e) => { console.error(e instanceof RefusedError || (e instanceof Error && /not found\. Copy answers\.example\.json/.test(e.message)) ? e.message : e); process.exit(1); });
