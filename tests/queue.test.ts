import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { openDb, upsertJob, putScore } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { AnswersSchema } from '../src/apply/answers.js';
import { prepareBatch, pickTop, rankedJobs } from '../src/apply/prepare.js';
import { backfillQueue, recordPrepared, queueRows, renderQueue, preparedOn, remainingToday, dailyCap, etDate, DEFAULT_DAILY_CAP } from '../src/apply/queue.js';
import { markJob } from '../src/marking.js';
import { buildSheet } from '../src/apply/sheet.js';
import { startMockAts, humanClick, type MockAts } from './helpers/mockAts.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
const answers = AnswersSchema.parse({ name: 'Test Person', first_name: 'Test', last_name: 'Person', email: 'test@example.com', phone: '555-0100', city: 'X', state: 'NY', country: 'US', linkedin: 'https://example.test/in/x', resumes: { A: 'resumes/a.pdf' }, answers: { work_authorization: 'Yes', eeo_gender: 'REPLACE_ME' }, custom_answers: [{ match: 'favorite color', answer: 'blue' }] });
const TODAY = etDate();
function mkdb(n: number, o: { digest?: boolean } = {}) {
  const db = openDb(':memory:');
  for (let i = 1; i <= n; i++) {
    upsertJob(db, { source: 'lever', id: String(i), company: `Co${i}`, title: `Engineer ${i}`, location: 'New York, NY', description: 'x', url: `https://example.test/lever/${i}` }, 1, null);
    putScore(db, `lever:${i}`, cacheVersion('v3'), { score: 90 - i, track: 'A', fit_reasons: [`Strong match ${i} on TypeScript and NYC`, 'second'], gaps: ['g'], apply_priority: 'high' });
    if (o.digest !== false) db.prepare('UPDATE jobs SET digest_date=? WHERE key=?').run(TODAY, `lever:${i}`);
  }
  return db;
}
let browser: Browser; let mock: MockAts | null = null;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });
afterEach(async () => { await mock?.close(); mock = null; });

describe('review queue', () => {
  it('prepared jobs are not picked again until marked applied or skip', () => {
    const db = mkdb(4);
    expect(pickTop(db, TODAY, 2).map((p) => p.key)).toEqual(['lever:1', 'lever:2']);
    recordPrepared(db, 'lever:1', true); recordPrepared(db, 'lever:2', true);
    expect(pickTop(db, TODAY, 2).map((p) => p.key)).toEqual(['lever:3', 'lever:4']);      // queued ones are skipped, next best take the slots
    expect(rankedJobs(db, TODAY).map((p) => p.key)).not.toContain('lever:1');
    markJob(db, 'lever:1', 'skip');                                                         // marking removes it from the queue view...
    expect(queueRows(db, tmp).map((r) => r.key)).toEqual(['lever:2']);
    expect(pickTop(db, TODAY, 4).map((p) => p.key)).not.toContain('lever:1');             // ...and it is never offered again
  });
  it('queue view: company, title, score, pay, one-line fit reason, file paths', () => {
    const db = mkdb(1); const letter = path.join(tmp, 'letter.pdf'); fs.writeFileSync(letter, 'x');
    recordPrepared(db, 'lever:1', false, { letterPdf: letter, note: path.join(tmp, 'missing.md') });
    const rows = queueRows(db, tmp); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ company: 'Co1', title: 'Engineer 1', score: 89, complete: false, fit: 'Strong match 1 on TypeScript and NYC' });
    expect(rows[0].files.letterPdf).toBe(letter); expect(rows[0].files.note).toBeNull();     // a path that no longer exists is not listed
    const txt = renderQueue(rows, { used: 1, cap: 10 });
    expect(txt).toMatch(/Co1 - Engineer 1\s+score 89/); expect(txt).toMatch(/fit: Strong match 1/); expect(txt).toContain(letter); expect(txt).toMatch(/NOT COMPLETE/); expect(txt).toMatch(/1\/10/);
  });
  it('daily cap: default 10, env override, re-preparing the same job does not count twice, resets per day', () => {
    expect(DEFAULT_DAILY_CAP).toBe(10); expect(dailyCap({} as any)).toBe(10); expect(dailyCap({ JOB_RADAR_DAILY_CAP: '4' } as any)).toBe(4); expect(dailyCap({ JOB_RADAR_DAILY_CAP: 'zero' } as any)).toBe(10);
    const db = mkdb(12);
    for (let i = 1; i <= 7; i++) recordPrepared(db, `lever:${i}`, true);
    recordPrepared(db, 'lever:1', true);                                                    // --force re-run
    expect(preparedOn(db, TODAY)).toBe(7); expect(remainingToday(db, TODAY)).toBe(3); expect(remainingToday(db, TODAY, 5)).toBe(0);
    recordPrepared(db, 'lever:8', true, {}, '2020-01-01T12:00:00Z'); expect(preparedOn(db, TODAY)).toBe(7);   // an old day does not count
  });
  it('jobs prepared before the queue existed are imported once (note or screenshot present), never applied/skip ones, never letter-only', () => {
    const db = mkdb(5); const dir = fs.mkdtempSync(path.join(tmp, 'bf-'));
    fs.writeFileSync(path.join(dir, 'lever-1.md'), 'n'); fs.writeFileSync(path.join(dir, 'lever-2-form.png'), 'x'); fs.writeFileSync(path.join(dir, 'lever-3-cover-letter.md'), 'l'); fs.writeFileSync(path.join(dir, 'lever-4.md'), 'n'); fs.writeFileSync(path.join(dir, 'lever-99.md'), 'n');
    markJob(db, 'lever:4', 'skip');
    expect(backfillQueue(db, dir)).toBe(2); expect(backfillQueue(db, dir)).toBe(0);
    expect(queueRows(db, dir).map((r) => r.key).sort()).toEqual(['lever:1', 'lever:2']); expect(pickTop(db, TODAY, 5).map((p) => p.key)).toEqual(['lever:3', 'lever:5']);
  });
  it('mark is idempotent and only ever writes applied / skip', () => {
    const db = mkdb(1);
    expect(markJob(db, 'lever:1', 'applied')).toMatchObject({ ok: true, changed: true });
    expect(markJob(db, 'lever:1', 'applied')).toMatchObject({ ok: true, changed: false });
    expect(markJob(db, 'lever:nope', 'applied').ok).toBe(false);
    expect(() => markJob(db, 'lever:1', 'deleted' as any)).toThrow();
    expect((db.prepare('SELECT status FROM jobs WHERE key=?').get('lever:1') as any).status).toBe('applied');
  });
});

describe('sheet: copy-ready manual path', () => {
  it('prints answers, letter text and file paths; skips placeholders; opens nothing', () => {
    const db = mkdb(1); const dir = fs.mkdtempSync(path.join(tmp, 's-'));
    fs.writeFileSync(path.join(dir, 'lever-1-cover-letter.md'), 'Dear team, this is the letter body.'); fs.writeFileSync(path.join(dir, 'lever-1.md'), '# note\nTailored note body.');
    fs.writeFileSync(path.join(dir, 'TP_Cover_Letter_Co1.pdf'), 'x'); fs.writeFileSync(path.join(dir, 'TP_Cover_Letter_Co1.pdf.job'), 'lever:1');
    const t = buildSheet(db, 'lever:1', answers, dir);
    expect(t).toMatch(/Email: test@example.com/); expect(t).toMatch(/Phone: 555-0100/); expect(t).toMatch(/Work authorization: Yes/); expect(t).toMatch(/favorite color: blue/);
    expect(t).not.toMatch(/Gender/);                       // REPLACE_ME placeholder is never printed as an answer
    expect(t).toMatch(/Dear team, this is the letter body\./); expect(t).toMatch(/Tailored note body/); expect(t).toContain(path.join(dir, 'TP_Cover_Letter_Co1.pdf'));
    expect(t).toMatch(/Resume \(track A\): resumes\/a\.pdf/); expect(t).toContain('https://example.test/lever/1');
    expect(buildSheet(db, 'lever:1', answers, path.join(tmp, 'empty'))).toMatch(/no letter text yet: run  npm run letter -- lever:1/);
  });
});

describe('batch: background tabs, handed off as each passes VERIFY, live "ready to review" list', () => {
  it('3 jobs, 2 at a time: every tab handed off, counter climbs to 3/3, queue + cap recorded, human submit arrives once per click', async () => {
    mock = await startMockAts(); const db = mkdb(3); const lines: string[] = [];
    const b = await prepareBatch({ db, ids: ['lever:1', 'lever:2', 'lever:3'], answers, llm: null, noNote: true, noLetter: true, browser, preparedDir: tmp, handoff: true, parallel: 2, log: (s) => lines.push(s), urlFor: () => mock!.url });
    const ready = lines.filter((l) => /READY \(handed off/.test(l));
    expect(ready).toHaveLength(3); expect(ready[0]).toMatch(/ready to review: 1\/3/); expect(ready[2]).toMatch(/ready to review: 3\/3/);
    expect(lines.filter((l) => /^Handoff: the network guard is lifted/.test(l))).toHaveLength(3);
    expect(b.results.every((r) => !('error' in r) && r.handedOff)).toBe(true);
    expect(mock.posts).toHaveLength(0);                                                   // the tool submitted nothing
    const pages = b.results.map((r) => ('page' in r ? r.page! : null)!);
    await humanClick(pages[1], '#go'); await pages[1].waitForTimeout(500); expect(mock.posts).toHaveLength(1);
    expect(queueRows(db, tmp)).toHaveLength(3); expect(preparedOn(db, TODAY)).toBe(3);   // all three wait in the queue and count against today's cap
  });
  it('a tab opened AFTER another was handed off is still guarded', async () => {
    mock = await startMockAts(); const db = mkdb(1);
    const b = await prepareBatch({ db, ids: ['lever:1'], answers, llm: null, noNote: true, noLetter: true, browser, preparedDir: tmp, handoff: true, log: () => {}, urlFor: () => mock!.url });
    const first = (b.results[0] as any).page; expect((b.results[0] as any).handedOff).toBe(true);
    const fresh = await first.context().newPage(); await fresh.goto(mock.url);
    const res = await fresh.evaluate(() => fetch('/apply', { method: 'POST', body: 'x' }).then(() => 'sent', () => 'blocked'));
    expect(res).toBe('blocked'); expect(mock.posts).toHaveLength(0);
  });
});
