import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { openDb, upsertJob, putScore } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { AnswersSchema } from '../src/apply/answers.js';
import { prepareJob, prepareBatch } from '../src/apply/prepare.js';
import { SubmitGuardError, HandoffError } from '../src/apply/errors.js';
import { startDashboard, type Dashboard } from '../src/dashboard/server.js';
import { createLauncher } from '../src/dashboard/runs.js';
import { startMockAts, type MockAts } from './helpers/mockAts.js';

// "Open and fill" end to end, headless, against the local mock ATS. Temp dirs only; the answers file is written here; nothing leaves localhost.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-launch-'));
const shotDir = process.env.SHOT_LAUNCH_DIR ?? tmp; fs.mkdirSync(shotDir, { recursive: true });
const dbFile = path.join(tmp, 'jobs.db'), prepared = path.join(tmp, 'prepared'), answersFile = path.join(tmp, 'answers.json');
fs.mkdirSync(prepared);
fs.writeFileSync(answersFile, JSON.stringify(AnswersSchema.parse({ name: 'Test Person', first_name: 'Test', last_name: 'Person', email: 'test@example.com', phone: '555-0100', city: 'X', state: 'NY', country: 'US', linkedin: 'https://l', github: 'https://g', portfolio: 'https://p', school: 'S', graduation_date: '2027-05' })));
const DONE = 'FILL COMPLETE - review and submit';
let d: Dashboard; let browser: Browser; let mock: MockAts; let page: Page;
const tabs = new Map<string, Page>();   // the handed-off tabs, captured through the injected prepare wrappers (the launcher itself never exposes them)

beforeAll(async () => {
  mock = await startMockAts();
  const db = openDb(dbFile);
  const add = (src: string, i: number, score: number) => { upsertJob(db, { source: src, id: String(i), company: `Co${i}`, title: `Engineer ${i}`, location: 'New York, NY', description: 'x', url: `https://example.test/${src}/${i}` } as any, 1, null); putScore(db, `${src}:${i}`, cacheVersion('v3'), { score, track: 'A', fit_reasons: [`Reason ${i}`], gaps: ['g'], apply_priority: 'high' }); };
  add('lever', 1, 90); add('lever', 2, 80); add('lever', 3, 70); add('lever', 4, 30); add('workday', 5, 85);
  db.close();
  const launcher = createLauncher({
    db: openDb(dbFile), preparedDir: prepared, answersFile, headless: true, urlFor: () => mock.url, llm: null, noNote: true, noLetter: true,
    prepare: {
      job: async (o) => { const r = await prepareJob(o); if (r.page) tabs.set(r.key, r.page); return r; },
      batch: (o) => prepareBatch({ ...o, onResult: (r) => { if ('page' in r && r.page) tabs.set(r.key, r.page); o.onResult?.(r); } }),
    },
  });
  d = await startDashboard({ dbPath: dbFile, preparedDir: prepared, launcher, answersFile });
  browser = await chromium.launch({ headless: true });
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(d.url); await page.waitForSelector('tbody tr');
}, 60000);
afterAll(async () => { await browser?.close(); await d?.close(); await mock?.close(); });

const row = (n: number) => page.locator('tbody tr', { hasText: `Engineer ${n}` });
const post = (p: string, body: unknown) => fetch(d.url.replace(/\/$/, '') + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${d.port}`, 'x-job-radar-token': d.token }, body: JSON.stringify(body) });

describe('Open and fill from the dashboard', () => {
  it('shows Open and fill for lever rows, Apply by hand for other sources, and checkboxes + Fill selected', async () => {
    await row(1).getByRole('button', { name: 'Open and fill' }).waitFor({ state: 'visible', timeout: 10000 });
    await row(5).getByRole('button', { name: 'Apply by hand' }).waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => row(5).getByRole('button', { name: 'Open and fill' }).count()).toBe(0);
    await expect.poll(() => row(5).locator('input[type=checkbox]').count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Fill selected (0)' }).isDisabled()).toBe(true);
    await page.screenshot({ path: path.join(shotDir, 'dashboard-open-and-fill-buttons.png') });
  });

  it('click Open and fill -> the row reaches FILL COMPLETE; the same key cannot be launched again while its window is open', async () => {
    await row(1).getByRole('button', { name: 'Open and fill' }).click();
    await expect.poll(() => row(1).innerText(), { timeout: 45000 }).toContain(DONE);
    await expect.poll(() => row(1).getByRole('button', { name: 'Open and fill' }).count()).toBe(0);
    const again = await post('/api/launch', { keys: ['lever:1'] });
    expect(again.status).toBe(409); expect((await again.json()).error).toMatch(/already running|window/);
    const runs = await (await fetch(d.url + 'api/runs')).json();
    expect(runs.find((r: any) => r.key === 'lever:1')).toMatchObject({ state: 'complete', hasShot: true, windowOpen: true });
  }, 60000);

  it('the panel shows the form screenshot and a Focus window button that returns 200', async () => {
    await row(1).locator('.sub').click();
    await expect.poll(() => page.locator('#detail h2').innerText()).toBe('Engineer 1');
    await expect.poll(() => page.locator('#detail').innerText(), { timeout: 10000 }).toContain(DONE);
    const img = page.locator('#detail img#shot'); await img.waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/focus')), page.getByRole('button', { name: 'Focus window' }).click()]);
    expect(resp.status()).toBe(200);
    await page.screenshot({ path: path.join(shotDir, 'dashboard-fill-complete-panel.png') });
  });

  it('the handed-off tab is locked down for automation (click / evaluate throw) while bringToFront works; no submit ever reached the ATS', async () => {
    const tab = tabs.get('lever:1')!; expect(tab).toBeTruthy();
    await expect(tab.click('#go')).rejects.toBeInstanceOf(SubmitGuardError);
    await expect(tab.evaluate(() => 1)).rejects.toBeInstanceOf(HandoffError);
    await expect(tab.bringToFront()).resolves.toBeUndefined();
    expect(mock.posts).toHaveLength(0);
  });

  it('a low-fit job asks first: Cancel sends nothing, OK sends allowLowFit', async () => {
    await page.locator('#detail .x').click();
    await row(4).locator('input[type=checkbox]').check();
    const sent: string[] = []; page.on('request', (r) => { if (r.url().endsWith('/api/launch')) sent.push(r.postData() ?? ''); });
    let msg = '';
    page.once('dialog', (dlg) => { msg = dlg.message(); void dlg.dismiss(); });
    await page.getByRole('button', { name: /Fill selected \(1\)/ }).click();
    await expect.poll(() => msg).toContain('Engineer 4'); expect(sent).toHaveLength(0);
    page.once('dialog', (dlg) => { void dlg.accept(); });
    await page.getByRole('button', { name: /Fill selected \(1\)/ }).click();
    await expect.poll(() => sent.length).toBe(1); expect(JSON.parse(sent[0])).toEqual({ keys: ['lever:4'], allowLowFit: true });
    await expect.poll(() => row(4).innerText(), { timeout: 45000 }).toContain(DONE);
  }, 90000);

  it('Fill selected with two rows starts ONE batch and both reach a final state; still no submit', async () => {
    await row(2).locator('input[type=checkbox]').check(); await row(3).locator('input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Fill selected (2)' }).click();
    await expect.poll(() => row(2).innerText(), { timeout: 60000 }).toContain(DONE); await expect.poll(() => row(3).innerText(), { timeout: 60000 }).toContain(DONE);
    const runs = await (await fetch(d.url + 'api/runs')).json();
    expect(runs.filter((r: any) => ['lever:2', 'lever:3'].includes(r.key)).every((r: any) => r.state === 'complete')).toBe(true);
    expect(tabs.has('lever:2') && tabs.has('lever:3')).toBe(true);
    expect(mock.posts).toHaveLength(0);
  }, 90000);

  it('the server\'s refusal text is shown inline (already running) and the row keeps its status', async () => {
    await page.evaluate(() => (window as any).launch(['lever:1']));      // what a stale button would send
    await expect.poll(() => page.locator('#fillmsg').innerText()).toMatch(/already running|window is still open/);
    await expect.poll(() => row(1).locator('.err').innerText()).toMatch(/already running|window is still open/);
    await expect.poll(() => row(1).innerText()).toContain(DONE);
    expect(mock.posts).toHaveLength(0);
  });
});
