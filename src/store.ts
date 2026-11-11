import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';
import { jobKey, type Job } from './types.js';
import type { Score } from './scoring/schema.js';
import type { PayInfo, PayFlag } from './pay.js';
import type { ArrangementInfo } from './arrangement.js';
import { ensureSitesTable } from './apply/sites.js';
import { ensureQueueTable } from './apply/queue.js';
import { dedupNorm, sourcePriority, DEDUP_WINDOW_MS } from './dedupe.js';

export interface StoredJob extends Job { key: string; tier: number | null; filter_reason: string | null; first_seen: string; status: string }

export const dedupHash = (j: Pick<Job, 'company' | 'title' | 'location'>) =>
  crypto.createHash('sha1').update([j.company, j.title, j.location].map((s) => s.toLowerCase().replace(/\s+/g, ' ').trim()).join('|')).digest('hex');

export function openDb(file = process.env.JOB_RADAR_DB ?? DB_PATH): Database.Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      key TEXT PRIMARY KEY, source TEXT, id TEXT, company TEXT, title TEXT, location TEXT, tier INTEGER,
      description TEXT, url TEXT, pay TEXT, remote INTEGER, dedup_hash TEXT, filter_reason TEXT,
      first_seen TEXT, status TEXT DEFAULT 'new');
    CREATE INDEX IF NOT EXISTS jobs_dedup ON jobs(dedup_hash);
    CREATE TABLE IF NOT EXISTS scores (
      key TEXT, prompt_version TEXT, json TEXT, created_at TEXT, PRIMARY KEY (key, prompt_version));
  `);
  for (const col of ['pay_status', 'pay_source', 'pay_flag', 'pay_display', 'pay_reason', 'pay_raw']) if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?").get(col))) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
  for (const col of ['arrangement', 'arrangement_src', 'arrangement_evidence', 'hours_note']) if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?").get(col))) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='office_days'").get())) db.exec('ALTER TABLE jobs ADD COLUMN office_days INTEGER');
  for (const col of ['pay_min', 'pay_max']) if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?").get(col))) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} REAL`);
  for (const col of ['posted_at', 'posted_at_source', 'updated_raw']) if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?").get(col))) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='last_seen'").get())) db.exec('ALTER TABLE jobs ADD COLUMN last_seen TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS company_fetch (company TEXT PRIMARY KEY, seen_at TEXT)');   // seen_at of the latest successful fetch of that company's board
  ensureQueueTable(db);   // prep_queue: jobs prepared and waiting for the owner's review (additive table)
  ensureSitesTable(db);   // apply_sites: per-company 'can the apply form be filled' status (additive table, no existing data touched)
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='is_baseline'").get())) {
    db.exec('ALTER TABLE jobs ADD COLUMN is_baseline INTEGER DEFAULT 0');
    db.exec('UPDATE jobs SET is_baseline=1');   // every job already stored when this column was introduced existed before the freshness feature: its first_seen is NOT a posting date
  }
  if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='digest_date'").get())) db.exec('ALTER TABLE jobs ADD COLUMN digest_date TEXT');
  for (const col of ['dedup_norm', 'dup_of']) if (!(db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?").get(col))) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
  db.exec('CREATE INDEX IF NOT EXISTS jobs_dedup_norm ON jobs(dedup_norm)');
  db.exec('CREATE TABLE IF NOT EXISTS job_links (key TEXT, url TEXT, source TEXT, seen_at TEXT, PRIMARY KEY (key, url))');   // alternate postings of the same job, against the primary key
  const todo = db.prepare('SELECT key, company, title, location FROM jobs WHERE dedup_norm IS NULL').all() as { key: string; company: string; title: string; location: string }[];
  if (todo.length) {   // one-time backfill (only rows still NULL), single transaction
    const upd = db.prepare('UPDATE jobs SET dedup_norm=? WHERE key=?');
    db.transaction(() => { for (const r of todo) upd.run(dedupNorm({ company: r.company ?? '', title: r.title ?? '', location: r.location ?? '' }), r.key); })();
  }
  return db;
}

interface Match { key: string; source: string; url: string; status: string; first_seen: string }
/** Primary (non-superseded) rows with the same normalized company/title/location whose first_seen is within 30 days of `now`. */
function findMatches(db: Database.Database, norm: string, now: string): Match[] {
  if (!norm) return [];
  const t = Date.parse(now);
  const rows = db.prepare('SELECT key, source, url, status, first_seen FROM jobs WHERE dedup_norm=? AND dup_of IS NULL').all(norm) as Match[];
  return rows.filter((r) => { const f = Date.parse(r.first_seen); return Number.isFinite(f) && Number.isFinite(t) && Math.abs(t - f) <= DEDUP_WINDOW_MS; });
}
const addLink = (db: Database.Database, key: string, url: string, source: string, at: string) => {
  if (url) db.prepare('INSERT OR IGNORE INTO job_links (key,url,source,seen_at) VALUES (?,?,?,?)').run(key, url, source, at);
};
/** Decide what a posting with no stored key does. 'dup' = recorded as an alternate link of the primary; otherwise `superseded` are the lower-priority rows the new row will replace. */
function resolveDup(db: Database.Database, j: Job, norm: string, now: string): { dup: true } | { dup: false; superseded: Match[] } {
  const ms = findMatches(db, norm, now);
  const p = sourcePriority(j.source);
  const best = ms.filter((m) => sourcePriority(m.source) >= p).sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source) || a.first_seen.localeCompare(b.first_seen))[0];
  if (best) { if (best.url !== j.url) addLink(db, best.key, j.url, j.source, now); return { dup: true }; }
  return { dup: false, superseded: ms };
}
/** The new row became primary: retire the old ones, carry over applied/skip, copy scores (only if the new key has none), keep the old url. */
function supersede(db: Database.Database, newKey: string, j: Job, old: Match[], now: string) {
  const status = old.some((o) => o.status === 'applied') ? 'applied' : old.some((o) => o.status === 'skip') ? 'skip' : null;
  if (status) db.prepare("UPDATE jobs SET status=? WHERE key=? AND (status IS NULL OR status='new')").run(status, newKey);
  for (const o of old) {
    db.prepare('UPDATE jobs SET dup_of=?, filter_reason=? WHERE key=?').run(newKey, `duplicate of ${newKey}`, o.key);
    db.prepare('INSERT OR IGNORE INTO scores (key,prompt_version,json,created_at) SELECT ?,prompt_version,json,created_at FROM scores WHERE key=?').run(newKey, o.key);
    addLink(db, newKey, o.url, o.source, now);
  }
}

/** Inserts a job unless its key exists or the same job (normalized company/title/location, first_seen within 30 days) is already stored at >= priority. Returns true if inserted. */
export function insertIfNew(db: Database.Database, j: Job, tier: number | null, filterReason: string | null, now = new Date().toISOString()): boolean {
  const key = jobKey(j);
  const hash = dedupHash(j);
  if (db.prepare('SELECT 1 FROM jobs WHERE key=?').get(key)) return false;
  const norm = dedupNorm(j);
  const r = resolveDup(db, j, norm, now);
  if (r.dup) return false;
  db.transaction(() => {
    db.prepare(`INSERT INTO jobs (key,source,id,company,title,location,tier,description,url,pay,remote,dedup_hash,filter_reason,first_seen,dedup_norm)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key, j.source, j.id, j.company, j.title, j.location, tier, j.description, j.url, j.pay ?? null, j.remote ? 1 : 0, hash, filterReason, now, norm);
    supersede(db, key, j, r.superseded, now);
  })();
  return true;
}

export interface PayStamp { info: PayInfo; flag: PayFlag }
const payVals = (p?: PayStamp) => [p?.info.status ?? null, p?.info.min ?? null, p?.info.max ?? null, p?.info.source ?? null, p?.flag ?? null, p?.info.display ?? null, p?.info.reason ?? null, p?.info.raw ?? null];

/** Insert a new posting, or refresh tier / filter reason / pay of one we already have (no scoring involved). */
export interface JobMeta { seenAt?: string; pay?: PayStamp; arr?: ArrangementInfo; hours?: string[]; baseline?: boolean }
const metaVals = (m: JobMeta) => [...payVals(m.pay), m.arr?.arrangement ?? null, m.arr?.officeDays ?? null, m.arr?.source ?? null, m.arr?.evidence ?? null, m.hours?.length ? m.hours.join(', ') : null];

export function upsertJob(db: Database.Database, j: Job, tier: number | null, filterReason: string | null, meta: JobMeta = {}, now = new Date().toISOString()): 'new' | 'updated' | 'dup' {
  const key = jobKey(j);
  if (db.prepare('SELECT 1 FROM jobs WHERE key=?').get(key)) {
    db.prepare('UPDATE jobs SET tier=?, filter_reason=CASE WHEN dup_of IS NOT NULL THEN filter_reason ELSE ? END, pay_status=?, pay_min=?, pay_max=?, pay_source=?, pay_flag=?, pay_display=?, pay_reason=?, pay_raw=?, arrangement=?, office_days=?, arrangement_src=?, arrangement_evidence=?, hours_note=?, posted_at=?, posted_at_source=?, updated_raw=?, last_seen=COALESCE(?, last_seen) WHERE key=?').run(tier, filterReason, ...metaVals(meta), j.postedAt ?? null, j.postedSource ?? null, j.updatedRaw ?? null, meta.seenAt ?? null, key);
    return 'updated';
  }
  const hash = dedupHash(j);
  const norm = dedupNorm(j);
  const r = resolveDup(db, j, norm, now);
  if (r.dup) return 'dup';
  db.transaction(() => {
  db.prepare(`INSERT INTO jobs (key,source,id,company,title,location,tier,description,url,pay,remote,dedup_hash,filter_reason,first_seen,dedup_norm,pay_status,pay_min,pay_max,pay_source,pay_flag,pay_display,pay_reason,pay_raw,arrangement,office_days,arrangement_src,arrangement_evidence,hours_note,posted_at,posted_at_source,updated_raw,is_baseline,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key, j.source, j.id, j.company, j.title, j.location, tier, j.description, j.url, j.pay ?? null, j.remote ? 1 : 0, hash, filterReason, now, norm, ...metaVals(meta), j.postedAt ?? null, j.postedSource ?? null, j.updatedRaw ?? null, meta.baseline ? 1 : 0, meta.seenAt ?? null);
  supersede(db, key, j, r.superseded, now);
  })();
  return 'new';
}

export const getCachedScore = (db: Database.Database, key: string, pv: string): Score | null => {
  const r = db.prepare('SELECT json FROM scores WHERE key=? AND prompt_version=?').get(key, pv) as { json: string } | undefined;
  return r ? JSON.parse(r.json) : null;
};
export const putScore = (db: Database.Database, key: string, pv: string, s: Score) =>
  db.prepare('INSERT OR REPLACE INTO scores (key,prompt_version,json,created_at) VALUES (?,?,?,?)').run(key, pv, JSON.stringify(s), new Date().toISOString());

/** Record a successful board fetch: every posting in `jobs` was on the board at `seenAt`. A fetch that returns 0 postings is NOT recorded (an outage must not make every job look closed). */
export function recordFetch(db: Database.Database, company: string, postings: number, seenAt: string) {
  if (postings > 0) db.prepare('INSERT OR REPLACE INTO company_fetch (company, seen_at) VALUES (?,?)').run(company, seenAt);
}
