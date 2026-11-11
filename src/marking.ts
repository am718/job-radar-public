import type Database from 'better-sqlite3';

export type MarkStatus = 'applied' | 'skip';
export const isMarkStatus = (s: unknown): s is MarkStatus => s === 'applied' || s === 'skip';

/** The ONE place a job's status is changed to applied / skip. Used by `npm run mark` and by the dashboard's write path, so both behave identically. Idempotent: marking twice changes nothing more.
 *  Nothing else about the job is touched, and nothing is ever deleted. */
export function ensureMarkLog(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS mark_log (key TEXT, status TEXT, at TEXT)');
  if (!db.prepare("SELECT 1 FROM pragma_table_info('mark_log') WHERE name='via'").get()) db.exec('ALTER TABLE mark_log ADD COLUMN via TEXT');   // who marked it: cli | dashboard | auto (the ATS answered the owner's own submit with a success)
}

export type MarkVia = 'cli' | 'dashboard' | 'auto';
export function markJob(db: Database.Database, key: string, status: MarkStatus, via: MarkVia = 'cli'): { ok: boolean; was: string | null; changed: boolean } {
  if (!isMarkStatus(status)) throw new Error(`status must be applied or skip, got "${status}"`);
  const row = db.prepare('SELECT status FROM jobs WHERE key=?').get(key) as { status: string } | undefined;
  if (!row) return { ok: false, was: null, changed: false };
  if (row.status === status) return { ok: true, was: row.status, changed: false };
  db.prepare('UPDATE jobs SET status=? WHERE key=?').run(status, key);
  ensureMarkLog(db); db.prepare('INSERT INTO mark_log (key,status,at,via) VALUES (?,?,?,?)').run(key, status, new Date().toISOString(), via);   // when it happened: feeds the dashboard's per-day chart
  return { ok: true, was: row.status, changed: true };
}
