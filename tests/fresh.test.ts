import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseGreenhouse } from '../src/adapters/greenhouse.js';
import { parseLever } from '../src/adapters/lever.js';
import { parseAshby } from '../src/adapters/ashby.js';
import { postedInfo, FRESH_BONUS, FRESH_DAYS } from '../src/fresh.js';
import { rankScore } from '../src/rank.js';
import { openDb, upsertJob } from '../src/store.js';
import { processJobs, type ScanStats } from '../src/pipeline.js';
import { buildDigest } from '../src/digest.js';
import type { Job } from '../src/types.js';

const fx = (n: string) => JSON.parse(fs.readFileSync(`fixtures/${n}.json`, 'utf8'));
const mk = (o: Partial<Job> = {}): Job => ({ source: 'ashby', id: '1', company: 'Acme', title: 'Software Engineer', location: 'New York, NY', description: 'Build things. New grads welcome.', url: 'https://x/1', ...o });
const stats = (): ScanStats => ({ fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] });
const goodJson = JSON.stringify({ score: 80, track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' });
const ASOF = '2026-11-02';
const daysBefore = (n: number) => new Date(Date.parse(ASOF + 'T16:00:00Z') - n * 86400000).toISOString();   // 11:00 ET of that day

describe('ATS date parsers (fields verified in real responses)', () => {
  it('greenhouse: first_published is the posting date (published); updated_at is stored but never used', () => {
    const j = parseGreenhouse({ jobs: [{ id: 1, title: 't', first_published: '2026-10-30T10:50:29-04:00', updated_at: '2026-11-01T09:00:00-04:00', location: { name: 'NY' }, content: '' }, { id: 2, title: 'u', updated_at: '2026-11-01T09:00:00-04:00', location: { name: 'NY' }, content: '' }] }, 'X');
    expect(j[0]).toMatchObject({ postedAt: '2026-10-30T14:50:29.000Z', postedSource: 'published', updatedRaw: '2026-11-01T09:00:00-04:00' });
    expect(j[1].postedAt).toBeNull(); expect(j[1].postedSource).toBeNull(); expect(j[1].updatedRaw).toBeTruthy();   // updated_at alone never becomes a posting date
  });
  it('lever: createdAt (epoch ms) => created', () => {
    const j = parseLever([{ id: 'a', text: 't', createdAt: 1_790_000_000_000, categories: {}, hostedUrl: 'u' }, { id: 'b', text: 'u', categories: {}, hostedUrl: 'u' }], 'X');
    expect(j[0]).toMatchObject({ postedAt: new Date(1_790_000_000_000).toISOString(), postedSource: 'created' }); expect(j[1].postedAt).toBeNull();
  });
  it('ashby: publishedAt => published; garbage => null', () => {
    const j = parseAshby({ jobs: [{ id: 'a', title: 't', publishedAt: '2026-10-31T14:36:07.492+00:00', isListed: true }, { id: 'b', title: 'u', publishedAt: 'nonsense', isListed: true }, { id: 'c', title: 'v', isListed: true }] }, 'X');
    expect(j[0]).toMatchObject({ postedAt: '2026-10-31T14:36:07.492Z', postedSource: 'published' }); expect(j[1].postedAt).toBeNull(); expect(j[2].postedAt).toBeNull();
  });
  it('real saved responses: every fixture job parses to a valid past date', () => {
    for (const j of [...parseGreenhouse(fx('greenhouse'), 'D'), ...parseLever(fx('lever'), 'S'), ...parseAshby(fx('ashby'), 'R')]) {
      expect(j.postedAt, `${j.source}:${j.id}`).toBeTruthy(); expect(Date.parse(j.postedAt!)).toBeLessThan(Date.now() + 86400000); expect(['published', 'created']).toContain(j.postedSource);
    }
  });
});

describe('7-day cutoff and the no-first_seen-for-old-jobs rule', () => {
  const row = (o: object) => ({ posted_at: null, posted_at_source: null, first_seen: daysBefore(0), is_baseline: 1, ...o });
  it('day 0, 1, 7 are fresh; day 8 is not', () => {
    for (const [d, fresh] of [[0, true], [1, true], [FRESH_DAYS, true], [FRESH_DAYS + 1, false], [30, false]] as const) {
      const p = postedInfo(row({ posted_at: daysBefore(d), posted_at_source: 'published' }), ASOF); expect(p.fresh, `day ${d}`).toBe(fresh); expect(p.daysAgo).toBe(d);
    }
    expect(postedInfo(row({ posted_at: daysBefore(0), posted_at_source: 'published' }), ASOF).label).toMatch(/^today \(2026-11-02, published\)/);
    expect(postedInfo(row({ posted_at: daysBefore(3), posted_at_source: 'created' }), ASOF).label).toMatch(/^3 days ago \(2026-10-30, created\)/);
  });
  it('a baseline (pre-existing) job without a reliable date is "age unknown": its first_seen is NEVER used', () => {
    const p = postedInfo(row({ first_seen: daysBefore(0), is_baseline: 1 }), ASOF); expect(p).toMatchObject({ at: null, source: null, fresh: false, newToday: false }); expect(p.label).toMatch(/age unknown/);
  });
  it('a job that appeared after the baseline falls back to first_seen (valid freshness signal) and is NEW today', () => {
    const p = postedInfo(row({ first_seen: daysBefore(0), is_baseline: 0 }), ASOF); expect(p).toMatchObject({ source: 'first_seen', fresh: true, newToday: true }); expect(p.label).toMatch(/NEW today/);
    expect(postedInfo(row({ first_seen: daysBefore(2), is_baseline: 0 }), ASOF)).toMatchObject({ fresh: true, newToday: false });
  });
  it('a reliable ATS date wins over first_seen even for new jobs; an old reliable date makes a new job NOT fresh', () => {
    const p = postedInfo(row({ posted_at: daysBefore(40), posted_at_source: 'published', first_seen: daysBefore(0), is_baseline: 0 }), ASOF); expect(p).toMatchObject({ source: 'published', fresh: false, newToday: true });
  });
  it('updated_at style sources are not accepted as a posting date', () => {
    expect(postedInfo(row({ posted_at: daysBefore(0), posted_at_source: 'updated', is_baseline: 1 }), ASOF).at).toBeNull();
  });
  it('a date more than a day in the future is treated as unknown, not fresh', () => { expect(postedInfo(row({ posted_at: daysBefore(-10), posted_at_source: 'published' }), ASOF)).toMatchObject({ fresh: false, at: null }); });
});

describe('storage: baseline flags and migration', () => {
  it('a first-time company is all baseline; a job that appears later for a known company is NOT baseline', async () => {
    const db = openDb(':memory:');
    await processJobs(db, [mk({ id: 'a', title: 'Software Engineer A' }), mk({ id: 'b', title: 'Software Engineer B' })], null, stats());
    await processJobs(db, [mk({ id: 'a', title: 'Software Engineer A' }), mk({ id: 'b', title: 'Software Engineer B' }), mk({ id: 'c', title: 'Software Engineer C' })], null, stats());
    const r = Object.fromEntries((db.prepare('SELECT id, is_baseline FROM jobs').all() as any[]).map((x) => [x.id, x.is_baseline]));
    expect(r).toEqual({ a: 1, b: 1, c: 0 });
  });
  it('migration: rows already in an old database become baseline', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'old.db');
    const old = new Database(f); old.exec('CREATE TABLE jobs (key TEXT PRIMARY KEY, source TEXT, id TEXT, company TEXT, title TEXT, location TEXT, tier INTEGER, description TEXT, url TEXT, pay TEXT, remote INTEGER, dedup_hash TEXT, filter_reason TEXT, first_seen TEXT, status TEXT DEFAULT \'new\')'); old.prepare("INSERT INTO jobs (key,first_seen) VALUES ('x:1','2026-11-01T12:00:00Z')").run(); old.close();
    const db = openDb(f); expect((db.prepare('SELECT is_baseline b FROM jobs').get() as any).b).toBe(1);
    upsertJob(db, mk({ id: 'z', title: 'Software Engineer Z' }), 1, null); expect((db.prepare("SELECT is_baseline b FROM jobs WHERE key='ashby:z'").get() as any).b).toBe(0);
  });
  it('posted_at, source and updated_raw are stored and refreshed on rescans', async () => {
    const db = openDb(':memory:');
    await processJobs(db, [mk({ postedAt: '2026-10-01T00:00:00.000Z', postedSource: 'published', updatedRaw: 'u1' })], null, stats());
    await processJobs(db, [mk({ postedAt: '2026-10-02T00:00:00.000Z', postedSource: 'published', updatedRaw: 'u2' })], null, stats());
    expect(db.prepare('SELECT posted_at, posted_at_source, updated_raw FROM jobs').get()).toEqual({ posted_at: '2026-10-02T00:00:00.000Z', posted_at_source: 'published', updated_raw: 'u2' });
  });
});

describe('ranking: small boost for fresh, fit still decides', () => {
  it('at equal fit a fresh job outranks an older one', () => { expect(rankScore(70, 1, 'negotiable', 'remote', null, true)).toBe(rankScore(70, 1, 'negotiable', 'remote', null, false) + FRESH_BONUS); });
  it('the boost is smaller than one pay step and one arrangement step, and smaller than a 3-point fit gap', () => {
    expect(FRESH_BONUS).toBeLessThan(3);
    expect(rankScore(70, 1, 'negotiable', 'hybrid', 3, true)).toBeLessThan(rankScore(70, 1, 'negotiable', 'remote', null, false));
    expect(rankScore(70, 1, 'negotiable', 'remote', null, true)).toBeLessThan(rankScore(73, 1, 'negotiable', 'remote', null, false));
  });
});

describe('--fresh-only scoring and NEW today', () => {
  const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // first_seen is real wall-clock time, so NEW-today needs asOf = today
  const seedAndRun = async (second: Job[], asOf = ASOF) => {
    const db = openDb(':memory:'); let calls = 0;
    await processJobs(db, [mk({ id: 'seed', title: 'Software Engineer Seed' }), mk({ id: 'old', title: 'Software Engineer Old' })], null, stats());   // first scan of Acme: both are baseline
    await processJobs(db, second, async () => { calls++; return goodJson; }, stats(), 'v3', 'p', { freshOnly: true, asOf });
    return { db, calls, scored: (db.prepare('SELECT j.id FROM jobs j JOIN scores s ON s.key=j.key').all() as any[]).map((x) => x.id).sort() };
  };
  it('scores only jobs posted within 7 days (reliable date) or NEW to the database; old baseline jobs are skipped with no spend', async () => {
    const r = await seedAndRun([
      mk({ id: 'seed', title: 'Software Engineer Seed', postedAt: daysBefore(60), postedSource: 'published' }),
      mk({ id: 'old', title: 'Software Engineer Old', postedAt: daysBefore(90), postedSource: 'published' }),
      mk({ id: 'fresh', title: 'Software Engineer Fresh', postedAt: daysBefore(2), postedSource: 'published' }),
    ]);
    expect(r.scored).toEqual(['fresh']); expect(r.calls).toBe(1);
  });
  it('a job new to the database today is scored even if its ATS date is old (it is new to us); an old BASELINE job is not', async () => {
    const r = await seedAndRun([mk({ id: 'old', title: 'Software Engineer Old', postedAt: daysBefore(90), postedSource: 'published' }), mk({ id: 'backlog', title: 'Software Engineer Backlog', postedAt: daysBefore(90), postedSource: 'published' })], TODAY);
    expect(r.scored).toEqual(['backlog']);
    const newToday = (r.db.prepare('SELECT first_seen FROM jobs WHERE is_baseline=0').all() as any[]).length; expect(newToday).toBe(1);
  });
  it('without --fresh-only everything unscored is scored', async () => {
    const db = openDb(':memory:'); let calls = 0;
    await processJobs(db, [mk({ id: 'a', title: 'Software Engineer A', postedAt: daysBefore(90), postedSource: 'published' })], async () => { calls++; return goodJson; }, stats());
    expect(calls).toBe(1);
  });
});

describe('digest: "Posted in the last 7 days" section and posting-age labels', () => {
  const s = (score: number) => ({ score, track: 'A' as const, fit_reasons: ['x'], gaps: [], apply_priority: 'high' as const });
  const row = (company: string, score: number, daysAgo: number | null, extra: object = {}) => ({ key: company, company, title: `${company} role`, location: 'NYC', pay: null, url: `https://x/${company}`, tier: 1, payFlag: 'meets floor' as const, payDisplay: '$120,000-$150,000 base', arrangement: 'remote' as const, officeDays: null, hoursNote: '', score: s(score),
    posted: daysAgo == null ? postedInfo({ is_baseline: 1, first_seen: daysBefore(0) }, ASOF) : postedInfo({ posted_at: daysBefore(daysAgo), posted_at_source: 'published', is_baseline: 1 }, ASOF), ...extra });
  it('lists fresh jobs ranked by score with the posted date and days ago; keeps the other sections; labels every job', () => {
    const md = buildDigest([row('FreshLow', 60, 1), row('FreshHigh', 90, 5), row('Old', 95, 30), row('Unknown', 85, null), row('Edge', 70, 7), row('JustOver', 99, 8)], '2026-11-02', 6);
    const a = md.indexOf('# Posted in the last 7 days'); const sec = md.slice(a, md.indexOf('\n# ', a + 5));
    expect(a).toBeGreaterThan(md.indexOf('# High fit, pay unclear')); expect(a).toBeLessThan(md.indexOf('# Other jobs'));
    expect(sec).toContain('FreshHigh'); expect(sec).toContain('FreshLow'); expect(sec).toContain('Edge'); expect(sec).not.toContain('Old role'); expect(sec).not.toContain('Unknown role'); expect(sec).not.toContain('JustOver');
    expect(sec.indexOf('FreshHigh')).toBeLessThan(sec.indexOf('Edge')); expect(sec.indexOf('Edge')).toBeLessThan(sec.indexOf('FreshLow'));
    expect(sec).toContain('Posted: 5 days ago (2026-10-28, published)'); expect(sec).toContain('Posted: 1 day ago');
    expect(md).toContain('# General ranking'); expect(md).toContain('- Posted: '); expect(md).toMatch(/age unknown/); expect(md).toMatch(/older than 7 days/);
  });
  it('the freshness boost reorders equal-fit jobs in the top 15', () => {
    const md = buildDigest([row('Older', 70, 30), row('Newer', 70, 2)], '2026-11-02', 2);
    expect(md.indexOf('## 1. Newer')).toBeGreaterThan(-1); expect(md.indexOf('## 2. Older')).toBeGreaterThan(-1);
  });
});
