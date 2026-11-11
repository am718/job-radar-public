import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { openDb, upsertJob, putScore } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { pickTop, pickFillable, minScore, DEFAULT_MIN_SCORE, autoMarker } from '../src/apply/prepare.js';
import { submissionSucceeded, confirmationPage } from '../src/apply/submitted.js';
import { markJob } from '../src/marking.js';
import { startDashboard, type Dashboard } from '../src/dashboard/server.js';
import { etDate } from '../src/apply/queue.js';

const TODAY = etDate();
function mk(scores: number[]) {
  const db = openDb(':memory:');
  scores.forEach((sc, i) => {
    const id = String(i + 1);
    upsertJob(db, { source: 'lever', id, company: `Co${id}`, title: `Engineer ${id}`, location: 'New York, NY', description: 'x', url: `https://example.test/lever/${id}` }, 1, null);
    putScore(db, `lever:${id}`, cacheVersion('v3'), { score: sc, track: 'A', fit_reasons: ['r'], gaps: ['g'], apply_priority: 'low' });
    db.prepare('UPDATE jobs SET digest_date=? WHERE key=?').run(TODAY, `lever:${id}`);
  });
  return db;
}

describe('minimum-fit gate: jobs you are not qualified for are never opened', () => {
  it('pickTop skips jobs under the floor even when slots are free', () => {
    const db = mk([80, 55, 41, 39, 30, 22]);
    expect(DEFAULT_MIN_SCORE).toBe(40);
    expect(pickTop(db, TODAY, 10, undefined, { minScore: 40 }).map((p) => p.score)).toEqual([80, 55, 41]);   // 39, 30, 22 stay unopened although 7 slots are free
    expect(pickTop(db, TODAY, 10).length).toBe(6);                                                              // no floor given (library default): unchanged behaviour
  });
  it('pickFillable honours it and does not report low-fit jobs as protected skips', async () => {
    const db = mk([90, 20]);
    const r = await pickFillable(db, TODAY, 5, { minScore: 40, preflight: false });
    expect(r.picks.map((p) => p.key)).toEqual(['lever:1']);
  });
  it('JOB_RADAR_MIN_SCORE overrides the default; bad values fall back', () => {
    expect(minScore({ JOB_RADAR_MIN_SCORE: '55' } as any)).toBe(55);
    expect(minScore({ JOB_RADAR_MIN_SCORE: 'abc' } as any)).toBe(40);
    expect(minScore({} as any)).toBe(40);
  });
});

describe('auto-detecting that YOUR submit was accepted (passive, from the network reply)', () => {
  const ok = { status: 200 };
  it('Ashby: accepted only when the reply reads like a success', () => {
    const u = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction';
    expect(submissionSucceeded({ method: 'POST', url: u, ...ok, body: '{"data":{"submitApplicationForm":{"success":true}}}' })).toMatch(/Ashby/);
    expect(submissionSucceeded({ method: 'POST', url: u, ...ok, body: '{"errors":[{"message":"boom"}]}' })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: u, ...ok, body: '{"data":{"x":{"__typename":"SpamDetected"}}}' })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: u, status: 500, body: '{}' })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: u, ...ok })).toBeNull();                                                   // no body: cannot tell, so no
    expect(submissionSucceeded({ method: 'POST', url: 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', ...ok, body: '{"data":{}}' })).toBeNull();   // a read query is not a submit
  });
  it('Greenhouse and Lever: success replies and confirmation redirects only', () => {
    expect(submissionSucceeded({ method: 'POST', url: 'https://job-boards.greenhouse.io/acme/jobs/123', ...ok, body: '{}' })).toMatch(/Greenhouse/);
    expect(submissionSucceeded({ method: 'POST', url: 'https://boards.greenhouse.io/acme/jobs/123', status: 302, location: 'https://boards.greenhouse.io/acme/jobs/123/confirmation' })).toMatch(/Greenhouse/);
    expect(submissionSucceeded({ method: 'POST', url: 'https://boards.greenhouse.io/acme/jobs/123', status: 302, location: 'https://boards.greenhouse.io/acme/jobs/123' })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: 'https://job-boards.greenhouse.io/acme/jobs/123', status: 422, body: 'invalid' })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: 'https://jobs.lever.co/acme/abc/apply', status: 302, location: 'https://jobs.lever.co/acme/abc/thanks' })).toMatch(/Lever/);
    expect(submissionSucceeded({ method: 'POST', url: 'https://jobs.lever.co/acme/abc/apply', status: 200, body: 'captcha required' })).toBeNull();
  });
  it('ignores GETs, noise (captcha, analytics, S3 uploads) and non-https', () => {
    expect(submissionSucceeded({ method: 'GET', url: 'https://jobs.lever.co/acme/abc/apply', status: 200 })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: 'https://www.google.com/recaptcha/api2/reload?k=1', status: 200 })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: 'https://grnhse-prod.s3.amazonaws.com/jobs/123', status: 204 })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: 'http://jobs.lever.co/acme/abc/apply', status: 200 })).toBeNull();
    expect(submissionSucceeded({ method: 'POST', url: 'https://evil.example/jobs/123', status: 200, body: '{}' })).toBeNull();
  });
  it('a tab landing on an ATS confirmation page counts; other pages do not', () => {
    expect(confirmationPage('https://jobs.lever.co/acme/abc/thanks')).toMatch(/confirmation/);
    expect(confirmationPage('https://boards.greenhouse.io/acme/jobs/1/confirmation')).toBeTruthy();
    expect(confirmationPage('https://jobs.lever.co/acme/abc')).toBeNull();
    expect(confirmationPage('https://example.com/thanks')).toBeNull();
  });
  it('autoMarker marks applied once, records who did it, and is idempotent', () => {
    const db = mk([70]); const lines: string[] = [];
    const mark = autoMarker(db, (s) => lines.push(s));
    mark('lever:1', 'Lever accepted the application'); mark('lever:1', 'again');
    expect((db.prepare("SELECT status FROM jobs WHERE key='lever:1'").get() as any).status).toBe('applied');
    expect(db.prepare("SELECT via FROM mark_log WHERE key='lever:1'").all()).toEqual([{ via: 'auto' }]);   // second call changed nothing, so one log row
    expect(lines.join('\n')).toMatch(/marked applied automatically/);
    expect(markJob(db, 'lever:1', 'applied').changed).toBe(false);
  });
});

describe('dashboard: posting links, inline buttons, auto-applied label', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-')); const file = path.join(tmp, 'jobs.db');
  let d: Dashboard; let browser: Browser;
  beforeAll(async () => {
    const db = openDb(file);
    for (const i of [1, 2, 3]) { upsertJob(db, { source: 'lever', id: String(i), company: `Co${i}`, title: `Engineer ${i}`, location: 'New York, NY', description: 'x', url: `https://example.test/jobs/${i}` }, 1, null); putScore(db, `lever:${i}`, cacheVersion('v3'), { score: 80 - i, track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' }); }
    markJob(db, 'lever:3', 'applied', 'auto'); db.close();
    d = await startDashboard({ dbPath: file, preparedDir: tmp }); browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser.close(); await d.close(); });
  it('every row links to its posting, applied-by-the-tool is labelled, and the row button marks it', async () => {
    const page = await (await browser.newContext()).newPage(); await page.goto(d.url); await page.waitForSelector('tbody tr');
    const hrefs = await page.locator('tbody tr a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    expect(hrefs.sort()).toEqual(['https://example.test/jobs/1', 'https://example.test/jobs/2', 'https://example.test/jobs/3']);
    expect(await page.locator('tbody tr', { hasText: 'Co3' }).innerText()).toMatch(/applied \(auto\)/);
    expect(await page.locator('tbody tr', { hasText: 'Co3' }).getByRole('button').count()).toBe(0);                 // already applied: no buttons
    await page.locator('tbody tr', { hasText: 'Co1' }).getByRole('button', { name: 'Applied' }).click();
    await page.waitForFunction(() => /applied total/.test(document.querySelector('#cards')!.textContent!) && document.querySelector('#cards')!.textContent!.replace(/\s+/g, ' ').includes('2applied total'));
    expect(await page.locator('tbody tr', { hasText: 'Co1' }).innerText()).toMatch(/applied/);
    expect(await page.locator('tbody tr', { hasText: 'Co1' }).getByRole('button').count()).toBe(0);
    await page.close();
  });
});
