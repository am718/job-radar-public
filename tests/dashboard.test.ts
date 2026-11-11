import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import Database from 'better-sqlite3';
import { openDb, upsertJob, putScore } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { startDashboard, HOST, type Dashboard } from '../src/dashboard/server.js';
import { recordPrepared } from '../src/apply/queue.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
const file = path.join(tmp, 'jobs.db'); const prepared = path.join(tmp, 'prepared'); fs.mkdirSync(prepared);
let d: Dashboard; let browser: Browser;
beforeAll(async () => {
  const db = openDb(file);
  for (let i = 1; i <= 6; i++) {
    upsertJob(db, { source: 'lever', id: String(i), company: `Co${i}`, title: `Engineer ${i}`, location: 'New York, NY', description: 'x', url: `https://example.test/jobs/${i}`, postedAt: new Date(Date.now() - i * 86400000 * 3).toISOString() } as any, 1, null);
    putScore(db, `lever:${i}`, cacheVersion('v3'), { score: 100 - i * 10, track: i % 2 ? 'A' : 'B', fit_reasons: [`Reason ${i} <b>bold</b>`], gaps: [`Gap ${i}`], apply_priority: 'high' });
  }
  db.prepare("UPDATE jobs SET arrangement='remote', pay_display='$150k' WHERE key IN ('lever:1','lever:2')").run();
  recordPrepared(db, 'lever:3', true); fs.writeFileSync(path.join(prepared, 'lever-3.md'), '# note\nhello note'); fs.writeFileSync(path.join(prepared, 'L.pdf'), '%PDF-1.4 x'); fs.writeFileSync(path.join(prepared, 'L.pdf.job'), 'lever:3');
  db.close();
  d = await startDashboard({ dbPath: file, preparedDir: prepared }); browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser.close(); await d.close(); });
const get = async (p: string) => { const r = await fetch(d.url.replace(/\/$/, '') + p); return { r, j: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };
const send = (method: string, p: string, o: { host?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; body: string }>((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: d.port, path: p, method, agent: false, headers: { host: o.host ?? `127.0.0.1:${d.port}`, ...o.headers } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode!, body: b })); });
  q.on('error', rej); q.end(o.body);
});
const snapshot = () => { const x = new Database(file, { readonly: true }); const rows = x.prepare('SELECT * FROM jobs ORDER BY key').all(); const sc = x.prepare('SELECT * FROM scores ORDER BY key').all(); x.close(); return crypto.createHash('sha1').update(JSON.stringify([rows, sc])).digest('hex'); };

describe('dashboard binds to loopback only', () => {
  it('listens on 127.0.0.1, and no environment variable can change that', () => {
    expect(HOST).toBe('127.0.0.1'); expect((d.server.address() as any).address).toBe('127.0.0.1');
    expect(fs.readFileSync('src/dashboard/server.ts', 'utf8').match(/\.listen\(/g)).toHaveLength(1);
    expect(fs.readFileSync('src/dashboard/server.ts', 'utf8')).toMatch(/server\.listen\(o\.port \?\? 0, HOST,/);
  });
  it('is unreachable on any non-loopback address of this machine', async () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i!.address);
    for (const ip of [...ips, '::1']) {
      const code = await new Promise<string>((res) => { const q = http.get({ host: ip, port: d.port, path: '/api/stats', timeout: 1500 }, () => res('ANSWERED')); q.on('error', (e: any) => res(e.code ?? 'error')); q.on('timeout', () => { q.destroy(); res('timeout'); }); });
      expect(code, ip).not.toBe('ANSWERED');
    }
  });
  it('refuses a foreign Host header (DNS rebinding)', async () => { expect((await send('GET', '/api/stats', { host: 'evil.example:80' })).status).toBe(403); });
});

describe('read-only data path', () => {
  it('the reader connection cannot write; GET endpoints change nothing', async () => {
    expect(() => d.reader.prepare("UPDATE jobs SET status='applied'").run()).toThrow(/readonly/i);
    expect(() => d.reader.prepare('DELETE FROM jobs').run()).toThrow(/readonly/i);
    const before = snapshot();
    for (const p of ['/', '/api/jobs', '/api/stats', '/api/job?key=lever:3', '/letter?key=lever:3']) await get(p);
    expect(snapshot()).toBe(before);
  });
  it('every method other than GET (and the one POST /api/mark) is refused', async () => {
    const before = snapshot();
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) for (const p of ['/api/jobs', '/api/stats', '/', '/api/job?key=lever:1']) { const r = await send(m, p, { headers: { 'content-type': 'application/json' }, body: '{"key":"lever:1","status":"applied"}' }); expect(r.status, `${m} ${p}`).toBe(405); }
    expect(snapshot()).toBe(before);
  });
  it('lists scored jobs with the fields the table needs, and a job detail with strengths / gaps / note / letter', async () => {
    const { j } = await get('/api/jobs'); expect(j).toHaveLength(6); expect(j[0]).toMatchObject({ key: 'lever:1', score: 90, track: 'A', company: 'Co1', arrangement: 'remote', pay: '$150k', status: 'new' }); expect(j.find((x: any) => x.key === 'lever:3').status).toBe('queued');
    const det = (await get('/api/job?key=lever:3')).j; expect(det.strengths[0]).toMatch(/Reason 3/); expect(det.gaps).toEqual(['Gap 3']); expect(det.note).toMatch(/hello note/); expect(det.hasLetter).toBe(true);
    const pdf = await get('/letter?key=lever:3'); expect(pdf.r.headers.get('content-type')).toBe('application/pdf');
    expect((await get('/letter?key=../../etc/passwd')).r.status).toBe(404);
  });
});

describe('marking: the only write', () => {
  const own = () => ({ origin: `http://127.0.0.1:${d.port}`, 'x-job-radar-token': d.token });
  const mark = (body: unknown, h: Record<string, string> = { 'content-type': 'application/json' }) => send('POST', '/api/mark', { headers: { ...own(), ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  it('marks applied, is idempotent, changes nothing else, and feeds the counters', async () => {
    const other = (db: Database.Database) => db.prepare("SELECT key,company,title,status,url FROM jobs WHERE key!='lever:1' ORDER BY key").all();
    const x = new Database(file, { readonly: true }); const before = other(x); x.close();
    const a = await mark({ key: 'lever:1', status: 'applied' }); expect(a.status).toBe(200); expect(JSON.parse(a.body)).toMatchObject({ changed: true, was: 'new' });
    const b = await mark({ key: 'lever:1', status: 'applied' }); expect(JSON.parse(b.body)).toMatchObject({ ok: true, changed: false });
    const y = new Database(file, { readonly: true }); expect(other(y)).toEqual(before); expect((y.prepare("SELECT count(*) n FROM mark_log WHERE key='lever:1'").get() as any).n).toBe(1); y.close();   // second call logged nothing
    const st = (await get('/api/stats')).j; expect(st).toMatchObject({ applied: 1, appliedToday: 1, appliedWeek: 1, queued: 1, skipped: 0 }); expect(st.byDay).toHaveLength(1);
    expect(JSON.parse((await mark({ key: 'lever:2', status: 'skip' })).body).changed).toBe(true); expect((await get('/api/stats')).j.skipped).toBe(1);
  });
  it('rejects bad input, unknown jobs, foreign origins and non-JSON (form) posts', async () => {
    expect((await mark({ key: 'lever:4', status: 'deleted' })).status).toBe(400); expect((await mark({ key: 'nope:1', status: 'applied' })).status).toBe(404); expect((await mark('not json')).status).toBe(400);
    expect((await mark({ key: 'lever:4', status: 'applied' }, { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    expect((await mark('key=lever:4&status=applied', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect(((await get('/api/jobs')).j as any[]).find((x) => x.key === 'lever:4').status).toBe('new');
  });
});

describe('the page', () => {
  it('renders offline (no request leaves 127.0.0.1), filters, shows detail, marks, and escapes text', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } }); const page = await ctx.newPage(); const hosts = new Set<string>();
    page.on('request', (r) => { if (/^https?:/.test(r.url())) hosts.add(new URL(r.url()).host); });
    await page.goto(d.url); await page.waitForSelector('tbody tr');
    expect(await page.locator('tbody tr').count()).toBe(6);
    await page.selectOption('#f-arr', 'remote'); expect(await page.locator('tbody tr').count()).toBe(2);
    await page.selectOption('#f-arr', ''); await page.fill('#f-lo', '60'); expect(await page.locator('tbody tr').count()).toBe(4); await page.fill('#f-lo', '0');
    await page.check('#f-week'); expect(await page.locator('tbody tr').count()).toBe(2); await page.uncheck('#f-week');   // posted within 7 days: lever:1 (3d), lever:2 (6d)
    await page.selectOption('#f-track', 'B'); expect(await page.locator('tbody tr').count()).toBe(3); await page.selectOption('#f-track', '');
    await page.locator('tbody tr', { hasText: 'Co5' }).click(); await page.waitForSelector('#detail h2');
    expect(await page.locator('#detail').innerText()).toMatch(/Reason 5 <b>bold<\/b>/);        // shown as text, not injected as HTML
    expect(await page.locator('#detail b').count()).toBe(0);
    await page.getByRole('button', { name: 'Mark applied' }).click(); await page.waitForFunction(() => document.querySelector('#cards')!.textContent!.includes('2'));
    expect((await get('/api/jobs')).j.find((x: any) => x.key === 'lever:5').status).toBe('applied');
    await page.screenshot({ path: process.env.SHOT_DASH ?? path.join(tmp, 'dashboard.png'), fullPage: true });
    expect([...hosts]).toEqual([`127.0.0.1:${d.port}`]); await ctx.close();
  });
});
