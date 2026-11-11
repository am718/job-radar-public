import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hoursNote } from '../src/arrangement.js';
import { buildDigest } from '../src/digest.js';
import { openDb, recordFetch } from '../src/store.js';
import { processJobs, stillOpenRows, digestRowsFor, type ScanStats } from '../src/pipeline.js';
import type { Job } from '../src/types.js';

const s = (score: number) => ({ score, track: 'A' as const, fit_reasons: ['x'], gaps: [], apply_priority: 'high' as const });
const row = (company: string, score: number, extra: object = {}) => ({ key: company, company, title: `${company} role`, location: 'NYC', pay: null, url: `https://x/${company}`, tier: 1, payFlag: 'meets floor' as const, payDisplay: '$120,000-$150,000 base', arrangement: 'remote' as const, officeDays: null, hoursNote: '', score: s(score), ...extra });

describe('general ranking lists only 40+', () => {
  it('shows 40+ jobs, hides the rest behind a one-line count', () => {
    const md = buildDigest([row('Hi', 80), row('Mid', 40), row('Low1', 39), row('Low2', 10), row('LowUnl', 20, { payFlag: 'pay unlisted' })], '2026-11-05', 5);
    const gen = md.slice(md.indexOf('# General ranking'), md.indexOf('# High fit'));
    expect(gen).toContain('Hi - Hi role'); expect(gen).toContain('Mid - Mid role');
    expect(gen).not.toContain('Low1'); expect(gen).not.toContain('Low2');
    expect(md).toContain('3 more jobs scored below 40 today (not shown)');
    expect(md).not.toMatch(/Low1 - Low1 role/);
  });
  it('prints "No new jobs scored 40+ today" when nothing reaches 40', () => {
    const md = buildDigest([row('A', 39), row('B', 5)], '2026-11-05', 2);
    expect(md).toContain('No new jobs scored 40+ today'); expect(md).toContain('2 more jobs scored below 40 today (not shown)');
    expect(md).not.toContain('## 1.');
  });
});

describe('title-based hours detection', () => {
  it('flags the Replit "Weekend Shift" title', () => {
    expect(hoursNote('Help customers. Standard hours.', 'Support Engineer I (NYC, Weekend Shift)')).toEqual(['weekend shift (title)']);
  });
  it.each([
    ['Night Shift Support Engineer', 'night shift (title)'], ['Overnight Operations Analyst', 'overnight (title)'], ['SRE (On-Call Rotation)', 'on-call (title)'],
    ['Support Engineer - Rotating Shifts', 'rotating shift (title)'], ['Evening Shift Engineer', 'evening shift (title)'], ['Support Engineer (On Call)', 'on-call (title)'],
  ])('flags "%s"', (title, term) => { expect(hoursNote('', title)).toContain(term); });
  it('does not flag ordinary titles (Knight, Midnight, Eve)', () => {
    for (const t of ['Software Engineer', 'Knight Capital Software Engineer', 'Midnight Labs Engineer', 'Data Analyst, Weekday Support']) expect(hoursNote('', t)).toEqual([]);
  });
  it('is stored on the job and shown in the digest as a note only', async () => {
    const db = openDb(':memory:');
    const j: Job = { source: 'ashby', id: 'w', company: 'Replit', title: 'Support Engineer I (NYC, Weekend Shift)', location: 'New York, NY', description: 'Help users.', url: 'https://x/w' };
    await processJobs(db, [j], async () => JSON.stringify({ score: 70, track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' }), { fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] } as ScanStats);
    const r = db.prepare('SELECT hours_note, filter_reason FROM jobs').get() as any;
    expect(r.hours_note).toBe('weekend shift (title)');
    const md = buildDigest([row('Replit', 70, { hoursNote: r.hours_note })], '2026-11-05', 1);
    expect(md).toContain('Hours note: possible high-demand hours: weekend shift (title)');
  });
});

describe('Still open from earlier days', () => {
  const mk = (id: string, title: string): Job => ({ source: 'ashby', id, company: 'Acme', title, location: 'New York, NY', description: 'New grads welcome. $130,000 - $150,000 base.', url: `https://x/${id}` });
  const stats = (): ScanStats => ({ fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] });
  const scoreBy = (m: Record<string, number>) => async (_s: string, user: string) => { const id = Object.keys(m).find((k) => user.includes(`Role ${k}`))!; return JSON.stringify({ score: m[id], track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' }); };
  async function setup() {
    const db = openDb(':memory:');
    const jobs = [mk('a', 'Software Engineer Role a'), mk('b', 'Software Engineer Role b'), mk('c', 'Software Engineer Role c'), mk('d', 'Software Engineer Role d'), mk('e', 'Software Engineer Role e')];
    const t1 = '2026-11-01T12:00:00.000Z';
    await processJobs(db, jobs, scoreBy({ a: 90, b: 75, c: 59, d: 80, e: 65 }), stats(), undefined, undefined, { seenAt: t1, asOf: '2026-11-01' });
    recordFetch(db, 'Acme', jobs.length, t1);
    db.prepare("UPDATE jobs SET status='seen', digest_date='2026-11-01'").run();
    return { db, jobs, t1 };
  }
  it('lists 60+ unmarked jobs still on the board from earlier digests, sorted by score; keeps them until marked', async () => {
    const { db } = await setup();
    const rows = stillOpenRows(db, '2026-11-05');
    expect(rows.map((r) => r.score.score)).toEqual([90, 80, 75, 65]);   // 59 is below 60
    const md = buildDigest([], '2026-11-05', 0, 0, rows);
    expect(md).toContain('# Still open from earlier days (4)');
    expect(md).toMatch(/\*\*90\*\* Acme - Software Engineer Role a \(New York, NY\) \| Pay: .*\| .*\| Posted: .*\| https:\/\/x\/a/);
    // still there on a later day, until marked
    expect(stillOpenRows(db, '2026-11-20').length).toBe(4);
    db.prepare("UPDATE jobs SET status='applied' WHERE id='a'").run(); db.prepare("UPDATE jobs SET status='skip' WHERE id='d'").run();
    expect(stillOpenRows(db, '2026-11-05').map((r) => r.score.score)).toEqual([75, 65]);
  });
  it('drops a job that is no longer on the board (absent from the company\'s latest successful fetch)', async () => {
    const { db, jobs } = await setup();
    const t2 = '2026-11-03T12:00:00.000Z';
    await processJobs(db, jobs.filter((j) => j.id !== 'a'), null, stats(), undefined, undefined, { seenAt: t2 });
    recordFetch(db, 'Acme', 4, t2);
    expect(stillOpenRows(db, '2026-11-05').map((r) => r.key.split(':')[1])).not.toContain('a');
    expect(stillOpenRows(db, '2026-11-05').length).toBe(3);
  });
  it('an empty/failed fetch (0 postings) does not close every job', async () => {
    const { db } = await setup();
    recordFetch(db, 'Acme', 0, '2026-11-04T12:00:00.000Z');
    expect(stillOpenRows(db, '2026-11-05').length).toBe(4);
  });
  it('excludes jobs already in today\'s digest and jobs with no board record', async () => {
    const { db } = await setup();
    db.prepare("UPDATE jobs SET digest_date='2026-11-05' WHERE id='b'").run();
    expect(stillOpenRows(db, '2026-11-05').length).toBe(3);
    db.prepare('UPDATE jobs SET last_seen=NULL').run();
    expect(stillOpenRows(db, '2026-11-05').length).toBe(0);
  });
  it('makes no LLM call and today\'s rows are unaffected', async () => {
    const { db } = await setup();
    expect(digestRowsFor(db, '2026-11-01').length).toBe(5);
  });
});

describe('monthly spend cap', () => {
  async function ledger(log: { ts: string; phase: string; label: string; usd: number }[], feedSpent = 0) {
    const f = path.join(os.tmpdir(), `spend-m-${Date.now()}-${Math.random()}.json`);
    process.env.SPEND_FILE = f; process.env.PRICE_IN_PER_MTOK = '2'; process.env.PRICE_OUT_PER_MTOK = '10'; process.env.ANTHROPIC_API_KEY = 'x-test';
    fs.writeFileSync(f, JSON.stringify({ phases: { FEED: { cap_usd: 6, spent_usd: feedSpent } }, log }));
    vi.resetModules();
    return import('../src/spend.js');
  }
  const iso = (d: string) => `${d}T15:00:00.000Z`;
  it('FEED becomes a $20 monthly cap (old $6 lifetime cap migrated)', async () => {
    const m = await ledger([{ ts: iso('2026-11-01'), phase: 'FEED', label: 'scan', usd: 5.26 }], 5.26);
    expect(m.loadLedger().phases.FEED).toMatchObject({ cap_usd: 20, monthly: true });
    expect(m.spentFor(m.loadLedger(), 'FEED', new Date(iso('2026-11-05')))).toBeCloseTo(5.26);
  });
  it('resets on the 1st: last month\'s spend does not count', async () => {
    const m = await ledger([{ ts: iso('2026-10-20'), phase: 'FEED', label: 'scan', usd: 19.5 }, { ts: iso('2026-11-02'), phase: 'FEED', label: 'scan', usd: 1 }], 20.5);
    expect(m.spentFor(m.loadLedger(), 'FEED', new Date(iso('2026-11-05')))).toBeCloseTo(1);
    expect(m.spentFor(m.loadLedger(), 'FEED', new Date(iso('2026-10-25')))).toBeCloseTo(19.5);
    expect(m.capWarning('FEED', new Date(iso('2026-11-05')))).toBeNull();
  });
  it('warns (does not stop) within 20% of the cap, and says so loudly when reached', async () => {
    const now = new Date(iso('2026-11-05'));
    let m = await ledger([{ ts: iso('2026-11-02'), phase: 'FEED', label: 'scan', usd: 15.99 }]);
    expect(m.capWarning('FEED', now)).toBeNull();
    m = await ledger([{ ts: iso('2026-11-02'), phase: 'FEED', label: 'scan', usd: 16 }]);
    expect(m.capWarning('FEED', now)).toMatch(/WARNING: within 20% of the monthly spend cap/);
    m = await ledger([{ ts: iso('2026-11-02'), phase: 'FEED', label: 'scan', usd: 20 }]);
    expect(m.capWarning('FEED', now)).toMatch(/SPEND CAP REACHED.*until the 1st/);
  });
  it('refuses a call that would pass the monthly cap, with no API call', async () => {
    const m = await ledger([{ ts: new Date().toISOString(), phase: 'FEED', label: 'scan', usd: 19.9999 }]);
    await expect(m.budgetedLlm('FEED', 't')('sys', 'user')).rejects.toBeInstanceOf(m.BudgetError);
  });
  it('lifetime phases (B, APPLY) are unchanged', async () => {
    const m = await ledger([{ ts: iso('2026-10-01'), phase: 'APPLY', label: 'x', usd: 0.5 }]);
    expect(m.loadLedger().phases.APPLY.monthly).toBeUndefined();
  });
});

describe('board fixes', () => {
  // Checks the owner's own board list, so it only runs where the (gitignored) companies.json exists.
  const have = fs.existsSync('companies.json');
  const cs = have ? JSON.parse(fs.readFileSync('companies.json', 'utf8')) as { name: string; ats: string; slug: string }[] : [];
  it.skipIf(!have)('Mistral is on Ashby (mistral.ai), Mercury on Greenhouse, Deel removed (public Ashby board empty)', () => {
    expect(cs.find((c) => c.name === 'Mistral')).toMatchObject({ ats: 'ashby', slug: 'mistral.ai' });
    expect(cs.find((c) => c.name === 'Mercury')).toMatchObject({ ats: 'greenhouse', slug: 'mercury' });
    expect(cs.find((c) => c.name === 'Deel')).toBeUndefined();
  });
});
