import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { openDb, upsertJob } from '../src/store.js';
import { AnswersSchema } from '../src/apply/answers.js';
import { prepareJob, prepareBatch } from '../src/apply/prepare.js';
import { SubmitGuardError, HandoffError } from '../src/apply/errors.js';
import { startMockAts, humanClick, type MockAts } from './helpers/mockAts.js';

// A local mock ATS records every POST it receives. Nothing here touches the real data/jobs.db or prepared/ (temp dir), and nothing leaves localhost.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
const answers = AnswersSchema.parse({ name: 'Test Person', first_name: 'Test', last_name: 'Person', email: 'test@example.com', phone: '555-0100', city: 'X', state: 'NY', country: 'US', linkedin: 'https://l', github: 'https://g', portfolio: 'https://p', school: 'S', graduation_date: '2027-05' });
let browser: Browser; let mock: MockAts | null = null;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });
afterEach(async () => { await mock?.close(); mock = null; });
const mkdb = (n = 1) => { const db = openDb(':memory:'); for (let i = 1; i <= n; i++) upsertJob(db, { source: 'lever', id: String(i), company: 'Mock Co', title: `Software Engineer ${i}`, location: 'New York, NY', description: 'x', url: `https://example.test/lever/${i}` }, 1, null); return db; };
const prep = async (o: { handoff?: boolean; mockOpts?: Parameters<typeof startMockAts>[0]; log?: (s: string) => void } = {}) => {
  mock = await startMockAts(o.mockOpts);
  const r = await prepareJob({ db: mkdb(), id: 'lever:1', answers, llm: null, noNote: true, noLetter: true, noShot: true, urlOverride: mock.url, browser, preparedDir: tmp, handoff: o.handoff, log: o.log ?? (() => {}) });
  return { r, page: r.page as Page, mock };
};
const title = (p: Page) => p.title();

describe('step 1: the cause, shown against a mock ATS (AUTOMATION phase, guard as today)', () => {
  it('a HUMAN native submit is dropped in-page (submit event cancelled, counter increments), the server sees nothing', async () => {
    const { r, page, mock } = await prep();
    expect(r.blockedSubmits).toBe(0); expect(mock.posts).toHaveLength(0);          // the tool itself never submitted
    await humanClick(page, '#go'); await page.waitForTimeout(500);
    expect(mock.posts).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).__jrBlockedSubmits)).toBe(1);
  });
  it('a HUMAN submit that goes over the network (fetch/XHR) is aborted by the route; it is listed in blockedRequests and the page sees a connection failure', async () => {
    const { r, page, mock } = await prep();
    await humanClick(page, '#go-fetch'); await page.waitForFunction(() => document.title !== '', null, { timeout: 5000 });
    expect(await title(page)).toBe('connection failed'); expect(mock.posts).toHaveLength(0);
    expect(r.blockedRequests.some((b) => b.startsWith('POST '))).toBe(true);
  });
});

describe('steps 2-3, 7: HANDOFF lifts the network + in-page blocks; the automation wrapper never lifts', () => {
  it('after handoff a HUMAN native submit reaches the server exactly once, with the prefilled values', async () => {
    const { r, page, mock } = await prep({ handoff: true });
    expect(r.complete).toBe(true); expect(r.handedOff).toBe(true); expect(mock.posts).toHaveLength(0);   // automation never posted
    await humanClick(page, '#go'); await page.waitForFunction(() => document.body.innerText.includes('Application received'), null, { timeout: 5000 });
    expect(mock.posts).toHaveLength(1); expect(decodeURIComponent(mock.posts[0].body)).toMatch(/name=Test\+Person|name=Test Person/);
  });
  it('after handoff a HUMAN submit over fetch/XHR also goes through exactly once', async () => {
    const { page, mock } = await prep({ handoff: true });
    await humanClick(page, '#go-fetch'); await page.waitForFunction(() => document.title.startsWith('ok'), null, { timeout: 5000 });
    expect(mock.posts).toHaveLength(1);
  });
  it('an automation-originated click/press/submit throws in the AUTOMATION phase', async () => {
    const { page, mock } = await prep();
    await expect(page.click('#go')).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.locator('#go-fetch').click()).rejects.toBeInstanceOf(SubmitGuardError);          // "Send" is submit-like by its text
    await expect(page.locator('#go').dblclick()).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.keyboard.press('Enter')).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.locator('input[name=name]').press('Enter')).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.mouse.click(5, 5)).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.evaluate(() => (document.forms[0] as HTMLFormElement).submit())).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.evaluate(() => (document.querySelector('#go') as HTMLElement).click())).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.dispatchEvent('#go', 'click')).rejects.toBeInstanceOf(SubmitGuardError);
    await page.waitForTimeout(300); expect(mock.posts).toHaveLength(0);
  });
  it('an automation-originated click/press/submit ALSO throws in the HANDOFF phase (the wrapper is not weakened), and the page cannot be acted on at all', async () => {
    const { page, mock } = await prep({ handoff: true });
    await expect(page.click('#go')).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.locator('#go-fetch').click()).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.keyboard.press('Enter')).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.evaluate(() => (document.forms[0] as HTMLFormElement).submit())).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(page.evaluate(() => 1)).rejects.toBeInstanceOf(HandoffError);                                   // no evaluate of any kind
    await expect(page.locator('input[name=name]').fill('x')).rejects.toBeInstanceOf(HandoffError);               // no filling either
    await page.waitForTimeout(300); expect(mock.posts).toHaveLength(0);
  });
  it('before handoff the tool can still click a harmless control (the wrapper only refuses submit-like ones)', async () => {
    const { page } = await prep();
    await page.setContent('<button type="button" id="b" onclick="document.title=\'clicked\'">Open menu</button>');
    await page.locator('#b').click(); expect(await title(page)).toBe('clicked');
  });
});

describe('step 4: batch runs hand off a tab only when it is fully prepared and verified', () => {
  it('good tab: handed off and the human submit arrives once; blocker tab: NOT handed off, guard stays, its submit is still dropped', async () => {
    mock = await startMockAts(); const lines: string[] = [];
    const b = await prepareBatch({ db: mkdb(2), ids: ['lever:1', 'lever:2'], answers, llm: null, noNote: true, noLetter: true, browser, preparedDir: tmp, handoff: true, log: (s) => lines.push(s), urlFor: (k) => (k === 'lever:1' ? mock!.url : `${mock!.url}login`) });
    const [good, bad] = b.results as any[];
    expect(good.handedOff).toBe(true); expect(bad.blocker?.kind).toBe('login'); expect(bad.handedOff).toBeFalsy();
    const out = lines.join('\n');
    expect(out).toMatch(/Handoff: the network guard is lifted\. The tool will not touch this page again\. Review and click Submit yourself\./);
    expect(out).toMatch(/npm run mark -- lever:1 applied/); expect(out).toMatch(/Handoff withheld for lever:2/);
    await humanClick(good.page, '#go'); await good.page.waitForFunction(() => document.body.innerText.includes('Application received'), null, { timeout: 5000 });
    expect(mock.posts).toHaveLength(1);
    await humanClick(bad.page, '#go-fetch'); await bad.page.waitForFunction(() => document.title !== '', null, { timeout: 5000 });
    expect(await title(bad.page)).toBe('connection failed'); expect(mock.posts).toHaveLength(1);                     // still guarded
    await b.browser.contexts()[0]?.close();
  }, 90000);
});

describe('step 6: if the human submit still fails, the cause is logged to the TERMINAL (never the page), challenges are only reported', () => {
  it('a 403 + x-amzn-waf-action on the application POST is reported with status, body size and vendor', async () => {
    const lines: string[] = [];
    const { page, mock } = await prep({ handoff: true, log: (s) => lines.push(s), mockOpts: { postStatus: 403, postHeaders: { 'x-amzn-waf-action': 'challenge' } } });
    await humanClick(page, "#go"); await page.waitForTimeout(2000);
    expect(mock.posts).toHaveLength(1);
    const err = lines.find((l) => l.startsWith('!!')) ?? '';
    expect(err).toMatch(/HTTP 403/); expect(err).toMatch(/response body \d+ bytes/); expect(err).toMatch(/AWS WAF/); expect(err).toMatch(/does not try to get past/);
  });
});
