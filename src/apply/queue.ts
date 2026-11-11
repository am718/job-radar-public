import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { cacheVersion } from '../scoring/scorer.js';
import { byHandFiles } from './byfiles.js';

// REVIEW QUEUE: jobs that were prepared (a form filled in a window, or the files made) and now wait for a human to review and submit. A job stays queued until it is marked
// applied or skip (`npm run mark`, or the dashboard), and a queued job is never picked again by --top. The daily cap keeps the volume reviewable.
export const DEFAULT_DAILY_CAP = 10;
export const dailyCap = (env: NodeJS.ProcessEnv = process.env): number => { const n = Number(env.JOB_RADAR_DAILY_CAP); return Number.isInteger(n) && n >= 1 ? n : DEFAULT_DAILY_CAP; };
export const etDate = (d: Date | string = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export function ensureQueueTable(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS prep_queue (key TEXT PRIMARY KEY, prepared_at TEXT, complete INTEGER, note TEXT, letter_pdf TEXT, letter_md TEXT, screenshot TEXT)');
}
export interface QueueFiles { note?: string | null; letterPdf?: string | null; letterMd?: string | null; screenshot?: string | null }
/** Remembers that a job was prepared. The first preparation time is kept (a --force re-run does not count again against the cap). */
export function recordPrepared(db: Database.Database, key: string, complete: boolean, f: QueueFiles = {}, now = new Date().toISOString()) {
  db.prepare('INSERT OR IGNORE INTO prep_queue (key, prepared_at, complete) VALUES (?,?,?)').run(key, now, complete ? 1 : 0);
  db.prepare('UPDATE prep_queue SET complete=?, note=COALESCE(?, note), letter_pdf=COALESCE(?, letter_pdf), letter_md=COALESCE(?, letter_md), screenshot=COALESCE(?, screenshot) WHERE key=?')
    .run(complete ? 1 : 0, f.note ?? null, f.letterPdf ?? null, f.letterMd ?? null, f.screenshot ?? null, key);
}
export const preparedOn = (db: Database.Database, date: string): number =>
  (db.prepare('SELECT prepared_at FROM prep_queue').all() as { prepared_at: string }[]).filter((r) => etDate(r.prepared_at) === date).length;
export const remainingToday = (db: Database.Database, date: string, cap = dailyCap()) => Math.max(0, cap - preparedOn(db, date));

export interface QueueRow {
  key: string; company: string; title: string; score: number | null; pay: string; fit: string; url: string; preparedAt: string; complete: boolean;
  files: { note: string | null; letterPdf: string | null; letterMd: string | null; screenshot: string | null };
}
const one = (s: string, n = 140) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
/** One-line fit reason: the first fit_reason of the cached score. */
export function fitLine(scoreJson: string | null | undefined): string { try { const s = JSON.parse(scoreJson ?? ''); return one(String(s.fit_reasons?.[0] ?? '')); } catch { return ''; } }

/** Prepared and waiting: prepared jobs whose status is neither applied nor skip. Newest first. */
export function queueRows(db: Database.Database, dir?: string): QueueRow[] {
  const rows = db.prepare(`SELECT q.*, j.company, j.title, j.url, j.pay_display, j.pay, s.json sj FROM prep_queue q JOIN jobs j ON j.key=q.key
    LEFT JOIN scores s ON s.key=q.key AND s.prompt_version=? WHERE j.status NOT IN ('applied','skip') ORDER BY q.prepared_at DESC`).all(cacheVersion('v3')) as any[];
  return rows.map((r) => {
    const f = byHandFiles(r.key, dir), ex = (p: string | null) => (p && fs.existsSync(p) ? p : null);
    return {
      key: r.key, company: r.company, title: r.title, url: r.url, preparedAt: r.prepared_at, complete: !!r.complete,
      score: r.sj ? JSON.parse(r.sj).score : null, pay: r.pay_display || r.pay || 'pay unlisted', fit: fitLine(r.sj),
      files: { note: ex(r.note) ?? f.note, letterPdf: ex(r.letter_pdf) ?? f.letterPdf, letterMd: ex(r.letter_md) ?? f.letterMd, screenshot: ex(r.screenshot) },
    };
  });
}
export function renderQueue(rows: QueueRow[], cap: { used: number; cap: number }): string {
  const L = [`=== REVIEW QUEUE: ${rows.length} prepared job(s) waiting for you (prepared today: ${cap.used}/${cap.cap}).`, `    Done with one? npm run mark -- <source:id> applied   or   skip`];
  if (!rows.length) L.push('    (nothing waiting)');
  for (const r of rows) {
    L.push('', `- ${r.company} - ${r.title}   score ${r.score ?? '?'}   ${r.pay}${r.complete ? '' : '   [NOT COMPLETE: finish by hand or use `npm run sheet`]'}`, `    ${r.key}   prepared ${r.preparedAt.slice(0, 16).replace('T', ' ')}Z`);
    if (r.fit) L.push(`    fit: ${r.fit}`);
    L.push(`    apply link: ${r.url}`);
    for (const [k, v] of [['note', r.files.note], ['cover letter PDF', r.files.letterPdf], ['cover letter text', r.files.letterMd], ['form screenshot', r.files.screenshot]] as const) if (v) L.push(`    ${k}: ${v}`);
  }
  return L.join('\n');
}

/** One-time-safe import of jobs prepared BEFORE the queue existed: a prepared/<source>-<id>.md note or -form.png screenshot means that job was prepared. Inserts only what is missing, dated by the file's modified time,
 *  and never for a job already marked applied / skip or not in the database. Idempotent. */
export function backfillQueue(db: Database.Database, dir = byHandDir()): number {
  let names: string[] = []; try { names = fs.readdirSync(dir); } catch { return 0; }
  const seen = new Map<string, number>();
  for (const n of names) {
    const m = /^(greenhouse|lever|ashby)-(.+?)(-form\.png|\.md)$/.exec(n); if (!m || /-cover-letter\.md$/.test(n)) continue;
    const key = `${m[1]}:${m[2]}`; const t = fs.statSync(`${dir}/${n}`).mtimeMs; seen.set(key, Math.min(seen.get(key) ?? Infinity, t));
  }
  let added = 0;
  for (const [key, t] of seen) {
    const j = db.prepare('SELECT status FROM jobs WHERE key=?').get(key) as { status: string } | undefined;
    if (!j || j.status === 'applied' || j.status === 'skip') continue;
    if (db.prepare('INSERT OR IGNORE INTO prep_queue (key, prepared_at, complete) VALUES (?,?,NULL)').run(key, new Date(t).toISOString()).changes) added++;
  }
  return added;
}
const byHandDir = () => process.env.JOB_RADAR_PREPARED ?? 'prepared';
