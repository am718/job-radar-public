import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { cacheVersion } from '../scoring/scorer.js';
import { byHandFiles } from '../apply/byfiles.js';
import { etDate } from '../apply/queue.js';

// Shapes shared by the local dashboard (real data, read-only connection) and the public demo (invented sample data). The page code is identical for both.
export { statsFrom, type JobRow, type JobDetail, type Stats } from './shared.js';
import { statsFrom, type JobRow, type JobDetail, type Stats } from './shared.js';

const one = (s: string, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const has = (db: Database.Database, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

/** Status shown to the owner: applied / skip come from the job, "queued" = prepared and waiting for review, else the job's own status (new / seen). */
export function jobRows(db: Database.Database): JobRow[] {
  const q = has(db, 'prep_queue') ? new Set((db.prepare('SELECT key FROM prep_queue').all() as { key: string }[]).map((r) => r.key)) : new Set<string>();
  const via = new Map<string, string>();   // who marked an applied job: auto (the ATS answered the owner's own submit), dashboard, cli
  if (has(db, 'mark_log') && (db.prepare("SELECT 1 FROM pragma_table_info('mark_log') WHERE name='via'").get())) for (const m of db.prepare("SELECT key, via FROM mark_log WHERE status='applied' AND via IS NOT NULL ORDER BY at").all() as { key: string; via: string }[]) via.set(m.key, m.via);
  const rows = db.prepare('SELECT j.key, j.company, j.title, j.url, j.status, j.pay_display, j.pay, j.arrangement, j.posted_at, s.json sj FROM jobs j JOIN scores s ON s.key=j.key AND s.prompt_version=? WHERE j.filter_reason IS NULL').all(cacheVersion('v3')) as any[];
  return rows.map((r) => {
    const sc = JSON.parse(r.sj);
    return { key: r.key, score: sc.score, track: sc.track, company: r.company, title: r.title, url: r.url, pay: r.pay_display || r.pay || 'pay unlisted', arrangement: r.arrangement || 'unknown', posted: r.posted_at ? String(r.posted_at).slice(0, 10) : null, fit: one(sc.fit_reasons?.[0] ?? ''), status: r.status === 'applied' || r.status === 'skip' ? r.status : q.has(r.key) ? 'queued' : r.status || 'new', via: r.status === 'applied' ? via.get(r.key) ?? null : null };
  }).sort((a, b) => b.score - a.score);
}
export function jobDetail(db: Database.Database, key: string, dir?: string): JobDetail | null {
  const r = db.prepare('SELECT j.key, j.url, s.json sj FROM jobs j JOIN scores s ON s.key=j.key AND s.prompt_version=? WHERE j.key=?').get(cacheVersion('v3'), key) as any;
  if (!r) return null;
  const sc = JSON.parse(r.sj), f = byHandFiles(key, dir);
  let note: string | null = null; try { note = f.note ? fs.readFileSync(f.note, 'utf8') : null; } catch { /* no note */ }
  return { key, strengths: (sc.fit_reasons ?? []).map((x: string) => one(x, 400)), gaps: (sc.gaps ?? []).map((x: string) => one(x, 400)), priority: sc.apply_priority ?? '', note, hasLetter: !!f.letterPdf, url: r.url };
}
/** applied/skipped counts come from the jobs table; today / this week / the per-day chart come from mark_log (jobs marked before it existed have no date and are counted as undated). */

/** applied/skipped counts come from the jobs table; today / this week / the per-day chart come from mark_log (jobs marked before it existed have no date and are counted as undated). */
export function statsFromDb(db: Database.Database, today = etDate()): Stats {
  const cnt = (st: string) => (db.prepare('SELECT count(*) n FROM jobs WHERE status=?').get(st) as { n: number }).n;
  const log = has(db, 'mark_log') ? (db.prepare("SELECT key, at FROM mark_log WHERE status='applied'").all() as { key: string; at: string }[]) : [];
  const applied = cnt('applied');
  const stillApplied = new Set((db.prepare("SELECT key FROM jobs WHERE status='applied'").all() as { key: string }[]).map((r) => r.key));
  const days = new Map<string, Set<string>>();
  for (const e of log) if (stillApplied.has(e.key)) { const d = etDate(e.at); (days.get(d) ?? days.set(d, new Set()).get(d)!).add(e.key); }
  const dated = new Set([...days.values()].flatMap((s) => [...s]));
  const queued = has(db, 'prep_queue') ? (db.prepare("SELECT count(*) n FROM prep_queue q JOIN jobs j ON j.key=q.key WHERE j.status NOT IN ('applied','skip')").get() as { n: number }).n : 0;
  return statsFrom(applied, [...days].map(([day, s]) => ({ day, n: s.size })), queued, cnt('skip'), applied - dated.size, today);
}
