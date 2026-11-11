import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normCompany, normTitle, normLocation, sourcePriority } from '../src/dedupe.js';
import { openDb, upsertJob, putScore, getCachedScore } from '../src/store.js';
import type { Job } from '../src/types.js';

const mk = (source: Job['source'], id: string, o: Partial<Job> = {}): Job => ({ source, id, company: 'Acme, Inc.', title: 'Senior Software Engineer (R12345)', location: 'New York, NY', description: 'x', url: `https://example.test/${source}/${id}`, ...o });
const day = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString();
const sc = { score: 80, track: 'A', fit_reasons: ['a', 'b'], gaps: ['g'], apply_priority: 'high' } as never;

describe('normalization', () => {
  it('company', () => {
    expect(normCompany('The Acme, Inc.')).toBe('acme');
    expect(normCompany('ACME  LLC')).toBe(normCompany('Acme Corp.'));
    expect(normCompany('Acme Technologies')).toBe('acme technologies');
    expect(normCompany('Acme')).not.toBe(normCompany('Acme Health'));
  });
  it('title', () => {
    expect(normTitle('Sr. Software Engineer (R12345)')).toBe('senior software engineer');
    expect(normTitle('Software Engineer - 12345')).toBe('software engineer');
    expect(normTitle('Data & Analytics Engineer')).toBe('data and analytics engineer');
    expect(normTitle('Software Engineer')).not.toBe(normTitle('Senior Software Engineer'));
    expect(normTitle('Software Engineer II')).not.toBe(normTitle('Software Engineer'));
  });
  it('location', () => {
    for (const l of ['Remote', 'remote - us', 'United States (Remote)', 'US Remote']) expect(normLocation(l)).toBe('remote');
    for (const l of ['New York, NY', 'New York City', 'NYC', 'New York, New York, United States']) expect(normLocation(l)).toBe('new york');
    expect(normLocation('New York')).not.toBe(normLocation('Newark'));
    expect(normLocation('Remote - Canada')).not.toBe('remote');
    expect(normLocation('Austin, TX, United States')).toBe('austin');
  });
  it('priority', () => {
    expect([sourcePriority('ashby'), sourcePriority('workday'), sourcePriority('hn'), sourcePriority('alert'), sourcePriority('link')]).toEqual([3, 2, 1, 0, 0]);
  });
});

describe('cross-source dedupe', () => {
  it('feed first, then ATS: ATS becomes primary and inherits state', () => {
    const db = openDb(':memory:');
    expect(upsertJob(db, mk('remoteok', '1'), 1, null, {}, day(0))).toBe('new');
    db.prepare("UPDATE jobs SET status='applied' WHERE key='remoteok:1'").run();
    putScore(db, 'remoteok:1', 'pv', sc);
    expect(upsertJob(db, mk('greenhouse', '9', { title: 'Sr. Software Engineer' , company: 'Acme'}), 1, null, {}, day(5))).toBe('new');
    const old = db.prepare("SELECT dup_of, filter_reason FROM jobs WHERE key='remoteok:1'").get() as any;
    expect(old).toEqual({ dup_of: 'greenhouse:9', filter_reason: 'duplicate of greenhouse:9' });
    expect((db.prepare("SELECT status, dup_of FROM jobs WHERE key='greenhouse:9'").get() as any)).toEqual({ status: 'applied', dup_of: null });
    expect(getCachedScore(db, 'greenhouse:9', 'pv')).not.toBeNull();
    expect(db.prepare("SELECT url FROM job_links WHERE key='greenhouse:9'").all()).toEqual([{ url: 'https://example.test/remoteok/1' }]);
    // the old feed row coming back does not lose its duplicate reason
    upsertJob(db, mk('remoteok', '1'), 1, null, {}, day(6));
    expect((db.prepare("SELECT filter_reason FROM jobs WHERE key='remoteok:1'").get() as any).filter_reason).toBe('duplicate of greenhouse:9');
  });
  it('does not overwrite an existing score on the new key', () => {
    const db = openDb(':memory:');
    upsertJob(db, mk('hn', '1'), 1, null, {}, day(0)); putScore(db, 'hn:1', 'pv', sc);
    upsertJob(db, mk('lever', '2'), 1, null, {}, day(1));
    expect(getCachedScore(db, 'lever:2', 'pv')).toEqual(sc);
  });
  it('ATS first, then feed: dup, link recorded, one visible row', () => {
    const db = openDb(':memory:');
    expect(upsertJob(db, mk('ashby', '1'), 1, null, {}, day(0))).toBe('new');
    expect(upsertJob(db, mk('adzuna', '7'), 1, null, {}, day(3))).toBe('dup');
    expect(upsertJob(db, mk('workday', '8'), 1, null, {}, day(4))).toBe('dup');
    expect(db.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 1 });
    expect((db.prepare("SELECT url, source FROM job_links WHERE key='ashby:1' ORDER BY source").all() as any[]).map((r) => r.source)).toEqual(['adzuna', 'workday']);
  });
  it('45 days apart is a re-post: two rows', () => {
    const db = openDb(':memory:');
    upsertJob(db, mk('lever', '1'), 1, null, {}, day(0));
    expect(upsertJob(db, mk('lever', '2'), 1, null, {}, day(45))).toBe('new');
    expect(db.prepare('SELECT COUNT(*) n FROM jobs WHERE dup_of IS NULL').get()).toEqual({ n: 2 });
  });
  it('same key again is updated; different titles or locations never merge', () => {
    const db = openDb(':memory:');
    upsertJob(db, mk('lever', '1'), 1, null, {}, day(0));
    expect(upsertJob(db, mk('lever', '1'), 1, null, {}, day(1))).toBe('updated');
    expect(upsertJob(db, mk('greenhouse', '2', { title: 'Software Engineer' }), 1, null, {}, day(1))).toBe('new');
    expect(upsertJob(db, mk('greenhouse', '3', { location: 'Newark, NJ' }), 1, null, {}, day(1))).toBe('new');
    expect(db.prepare('SELECT COUNT(*) n FROM jobs WHERE dup_of IS NULL').get()).toEqual({ n: 3 });
  });
});

describe('migration', () => {
  it('backfills dedup_norm on an old-shape db and keeps rows', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-')), 'old.db');
    const old = new Database(f);
    old.exec(`CREATE TABLE jobs (key TEXT PRIMARY KEY, source TEXT, id TEXT, company TEXT, title TEXT, location TEXT, tier INTEGER, description TEXT, url TEXT, pay TEXT, remote INTEGER, dedup_hash TEXT, filter_reason TEXT, first_seen TEXT, status TEXT DEFAULT 'new');
      INSERT INTO jobs (key,source,id,company,title,location,url,first_seen) VALUES ('lever:1','lever','1','The Acme Inc','Sr. Engineer (R100)','NYC','u','2026-01-01T00:00:00.000Z');`);
    old.close();
    const db = openDb(f);
    expect(db.prepare("SELECT dedup_norm, dup_of, status FROM jobs WHERE key='lever:1'").get()).toEqual({ dedup_norm: 'acme|senior engineer|new york', dup_of: null, status: 'new' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='jobs_dedup_norm'").get()).toBeTruthy();
    openDb(f).close();
    db.close();
  });
});
