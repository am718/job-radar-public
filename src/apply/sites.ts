import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export type SiteStatus = 'ok' | 'protected' | 'unknown';
export interface Site { company: string; ats: string | null; status: SiteStatus; vendor: string | null; reason: string | null; checked_at: string; source: 'preflight' | 'blocker' | 'manual' | 'seed' }
export const EXPIRY_DAYS = 14;

export function ensureSitesTable(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS apply_sites (company TEXT PRIMARY KEY, ats TEXT, status TEXT NOT NULL, vendor TEXT, reason TEXT, checked_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT \'preflight\')');
}
const norm = (c: string) => c.trim().toLowerCase();
const HERE = path.dirname(fileURLToPath(import.meta.url));
export function knownProtected(file = path.join(HERE, 'known-protected.json')): { company: string; ats?: string; vendor?: string; reason?: string }[] {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')).sites ?? []) as any[]; } catch { return []; }
}

export function isExpired(s: Pick<Site, 'checked_at' | 'source'>, now = new Date()): boolean {
  if (s.source === 'manual') return false;   // a correction you made by hand stays until you change it
  return now.getTime() - new Date(s.checked_at).getTime() > EXPIRY_DAYS * 86400_000;
}

export function getSite(db: Database.Database, company: string): Site | null {
  ensureSitesTable(db);
  const rows = db.prepare('SELECT * FROM apply_sites').all() as Site[];
  return rows.find((r) => norm(r.company) === norm(company)) ?? null;
}

/** The status used for decisions: a fresh (<14 days, or manual) row wins; otherwise the committed known-protected list; otherwise 'unknown' (treated as fillable). */
export function siteStatus(db: Database.Database, company: string, now = new Date(), seedFile?: string): { status: SiteStatus; vendor: string | null; reason: string | null; fresh: boolean; source: string } {
  const s = getSite(db, company);
  if (s && !isExpired(s, now)) return { status: s.status, vendor: s.vendor, reason: s.reason, fresh: true, source: s.source };
  const k = knownProtected(seedFile).find((x) => norm(x.company) === norm(company));
  if (k) return { status: 'protected', vendor: k.vendor ?? null, reason: k.reason ?? 'listed in known-protected.json', fresh: false, source: 'seed' };
  // an expired row no longer counts: the company is fillable again ('unknown') and the next pick rechecks it with a preflight
  return { status: 'unknown', vendor: s?.vendor ?? null, reason: s ? `last seen ${s.status} on ${s.checked_at.slice(0, 10)}, expired` : null, fresh: false, source: s ? `${s.source} (expired)` : 'none' };
}
export const isProtected = (db: Database.Database, company: string, now = new Date()) => siteStatus(db, company, now).status === 'protected';

export function recordSite(db: Database.Database, s: Omit<Site, 'checked_at'> & { checked_at?: string }) {
  ensureSitesTable(db);
  const old = getSite(db, s.company);
  if (old && old.company !== s.company) db.prepare('DELETE FROM apply_sites WHERE company=?').run(old.company);
  db.prepare('INSERT OR REPLACE INTO apply_sites (company,ats,status,vendor,reason,checked_at,source) VALUES (?,?,?,?,?,?,?)').run(s.company, s.ats, s.status, s.vendor, s.reason, s.checked_at ?? new Date().toISOString(), s.source);
}
export function allSites(db: Database.Database): Site[] { ensureSitesTable(db); return db.prepare('SELECT * FROM apply_sites ORDER BY status DESC, company').all() as Site[]; }
