import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium, type Browser } from 'playwright';
import { openDb, upsertJob, putScore } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { markJob } from '../src/marking.js';
import { recordPrepared } from '../src/apply/queue.js';
import { startDashboard, type Dashboard } from '../src/dashboard/server.js';
import { tokenOk, checkWrite } from '../src/dashboard/security.js';
import type { Launcher, RunStatus } from '../src/dashboard/launch.js';

// SECURITY of the endpoints that can start a browser. A fake launcher records every start(): the assertion that matters is "start was (not) called".
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launchsec-'));
const file = path.join(tmp, 'jobs.db'), prepared = path.join(tmp, 'prepared'); fs.mkdirSync(prepared);
const starts: { keys: string[]; allowLowFit: boolean }[] = []; const added: string[] = []; const busy = new Set<string>(); const focused: string[] = [];
const fake: Launcher = { isBusy: (k) => busy.has(k), start: (keys, o) => { starts.push({ keys, allowLowFit: o.allowLowFit }); }, list: (): RunStatus[] => [], focus: async (k) => { focused.push(k); return busy.has(k); }, close: async () => {} };
let d: Dashboard; let browser: Browser;
beforeAll(async () => {
  const db = openDb(file);
  const add = (source: string, id: string, score: number, title = `Engineer ${id}`) => { upsertJob(db, { source: source as any, id, company: `Co${id}`, title, location: 'New York, NY', description: 'x', url: `https://example.test/${source}/${id}` }, 1, null); putScore(db, `${source}:${id}`, cacheVersion('v3'), { score, track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' }); };
  for (let i = 1; i <= 14; i++) add('lever', String(i), 80);
  add('lever', 'low', 25); add('workday', 'w1', 90); add('lever', 'done', 90);
  markJob(db, 'lever:done', 'applied');
  const outside = path.join(tmp, 'outside.png'); fs.writeFileSync(outside, 'PNG'); recordPrepared(db, 'lever:14', true, { screenshot: outside });   // a screenshot path outside prepared/ must never be served
  db.close();
  d = await startDashboard({ dbPath: file, preparedDir: prepared, launcher: fake, addJob: async (_db, url) => { added.push(url); return { ok: true, status: 'new', key: 'link:abc' }; } }); browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser.close(); await d.close(); });
beforeEach(() => { added.length = 0; starts.length = 0; busy.clear(); focused.length = 0; process.env.JOB_RADAR_DAILY_CAP = '10'; });

const send = (method: string, p: string, o: { host?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; body: string }>((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: d.port, path: p, method, agent: false, headers: { host: o.host ?? `127.0.0.1:${d.port}`, ...o.headers } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode!, body: b })); });
  q.on('error', rej); q.end(o.body);
});
const good = () => ({ 'content-type': 'application/json', origin: `http://127.0.0.1:${d.port}`, 'x-job-radar-token': d.token });
const launch = (body: unknown, h: Record<string, string | undefined> = {}, host?: string) => {
  const headers = Object.fromEntries(Object.entries({ ...good(), ...h }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return send('POST', '/api/launch', { headers, host, body: typeof body === 'string' ? body : JSON.stringify(body) });
};

describe('launch endpoint: the good path', () => {
  it('a valid request from the dashboard page starts exactly one run with exactly those keys', async () => {
    const r = await launch({ keys: ['lever:1'] }); expect(r.status).toBe(202); expect(JSON.parse(r.body)).toMatchObject({ ok: true, started: ['lever:1'] });
    expect(starts).toEqual([{ keys: ['lever:1'], allowLowFit: false }]);
  });
  it('a batch is one start() call; duplicate keys in the request are folded', async () => {
    expect((await launch({ keys: ['lever:2', 'lever:3', 'lever:2'] })).status).toBe(202); expect(starts).toEqual([{ keys: ['lever:2', 'lever:3'], allowLowFit: false }]);
  });
});

describe('launch endpoint: every rejection (and start() is never called)', () => {
  const rejected = async (status: number, p: Promise<{ status: number; body: string }>, err?: RegExp) => { const r = await p; expect(r.status, r.body).toBe(status); if (err) expect(JSON.parse(r.body).error).toMatch(err); expect(starts).toEqual([]); };
  it('bad or missing token', async () => {
    await rejected(403, launch({ keys: ['lever:1'] }, { 'x-job-radar-token': 'wrong' }), /token/);
    await rejected(403, launch({ keys: ['lever:1'] }, { 'x-job-radar-token': d.token.slice(0, -1) + (d.token.endsWith('0') ? '1' : '0') }), /token/);
    await rejected(403, launch({ keys: ['lever:1'] }, { 'x-job-radar-token': undefined }), /token/);
  });
  it('bad or missing Origin, and cross-site Sec-Fetch-Site', async () => {
    await rejected(403, launch({ keys: ['lever:1'] }, { origin: 'https://evil.example' }), /origin/);
    await rejected(403, launch({ keys: ['lever:1'] }, { origin: `http://127.0.0.1:${d.port + 1}` }), /origin/);   // another local port is another origin
    await rejected(403, launch({ keys: ['lever:1'] }, { origin: 'null' }), /origin/);
    await rejected(403, launch({ keys: ['lever:1'] }, { origin: undefined }), /origin/);
    await rejected(403, launch({ keys: ['lever:1'] }, { 'sec-fetch-site': 'cross-site' }), /cross-site/);
  });
  it('foreign Host header (DNS rebinding), even with a valid token', async () => {
    await rejected(403, launch({ keys: ['lever:1'] }, {}, 'evil.example'), /host/);
    await rejected(403, launch({ keys: ['lever:1'] }, {}, `attacker.example:${d.port}`), /host/);
  });
  it('not JSON (what an HTML form or a no-cors fetch can send)', async () => {
    await rejected(415, launch('keys=lever:1', { 'content-type': 'application/x-www-form-urlencoded' }));
    await rejected(415, launch('{"keys":["lever:1"]}', { 'content-type': 'text/plain' }));
  });
  it('anything but POST', async () => {
    for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) { const r = await send(m, '/api/launch', { headers: good(), body: m === 'GET' ? undefined : '{"keys":["lever:1"]}' }); expect(r.status, m).toBe(405); }
    expect(starts).toEqual([]);
  });
  it('unknown, malformed and over-long keys; extra fields (no url/path/command can be passed); bad shapes', async () => {
    await rejected(404, launch({ keys: ['lever:nope'] }), /no such job/);
    for (const k of ['../../etc/passwd', 'lever:1;rm -rf /', 'lever:1 && open -a Calculator', 'LEVER:1', 'lever:', ':1', 'lever:' + 'x'.repeat(200), 'file:///etc/passwd', 'https://evil.example/apply']) await rejected(400, launch({ keys: [k] }), /bad job key/);
    for (const extra of [{ url: 'https://evil.example' }, { path: '/tmp/x' }, { cmd: 'open' }, { headless: false }, { answers: '/tmp/a.json' }]) await rejected(400, launch({ keys: ['lever:1'], ...extra }), /unexpected field/);
    await rejected(400, launch({ keys: [] })); await rejected(400, launch({ keys: 'lever:1' })); await rejected(400, launch([['lever:1']])); await rejected(400, launch('not json'), /bad JSON/);
    await rejected(400, launch({ keys: Array.from({ length: 11 }, (_, i) => `lever:${i + 1}`) }));
    await rejected(400, launch({ keys: ['lever:1'], allowLowFit: 'yes' }));
    await rejected(400, launch({ keys: ['lever:1'], pad: 'x'.repeat(20_000) }), /bad JSON/);   // body over 10 KB
  });
  it('a site the tool cannot fill, a job already applied, and a job already running are refused', async () => {
    await rejected(422, launch({ keys: ['workday:w1'] }), /apply by hand/);
    await rejected(409, launch({ keys: ['lever:done'] }), /already marked/);
    busy.add('lever:4'); await rejected(409, launch({ keys: ['lever:4'] }), /already running/);
  });
  it('fit under 40 needs the explicit override; the daily cap holds', async () => {
    await rejected(422, launch({ keys: ['lever:low'] }), /fit below 40/);
    expect((await launch({ keys: ['lever:low'], allowLowFit: true })).status).toBe(202); expect(starts).toEqual([{ keys: ['lever:low'], allowLowFit: true }]); starts.length = 0;
    process.env.JOB_RADAR_DAILY_CAP = '2';
    await rejected(429, launch({ keys: ['lever:5', 'lever:6', 'lever:7'] }), /daily cap/);
  });
});

describe('focus, screenshot, token handling', () => {
  it('focus needs the same checks and a real key', async () => {
    const f = (body: unknown, h: Record<string, string> = {}) => send('POST', '/api/focus', { headers: { ...good(), ...h }, body: JSON.stringify(body) });
    expect((await f({ key: 'lever:1' }, { 'x-job-radar-token': 'no' })).status).toBe(403);
    expect((await f({ key: 'lever:1' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await f({ key: 'lever:zzz' })).status).toBe(404);
    expect((await f({ key: 'lever:1' })).status).toBe(409);                       // no open window
    busy.add('lever:1'); expect((await f({ key: 'lever:1' })).status).toBe(200); expect(focused).toEqual(['lever:zzz'].filter(() => false).concat(['lever:1', 'lever:1']));
  });
  it('a screenshot path outside the prepared folder is never served, whatever the DB says', async () => {
    expect((await send('GET', '/shot?key=lever:14')).status).toBe(404);
    expect((await send('GET', '/shot?key=../../outside')).status).toBe(404);
  });
  it('the token is only in the page HTML, differs per process, and no GET returns it', async () => {
    expect(d.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await send('GET', '/')).body).toContain(`content="${d.token}"`);
    for (const p of ['/api/jobs', '/api/stats', '/api/runs', '/api/job?key=lever:1']) expect((await send('GET', p)).body).not.toContain(d.token);
    const other = await startDashboard({ dbPath: file, preparedDir: prepared, launcher: fake }); expect(other.token).not.toBe(d.token); await other.close();
    expect(tokenOk(d.token, d.token)).toBe(true); expect(tokenOk(undefined, d.token)).toBe(false); expect(tokenOk(['x'], d.token)).toBe(false); expect(tokenOk('', '')).toBe(false);
  });
});

describe('add a job link (the server fetches a URL, so the same gate applies)', () => {
  const add = (body: unknown, h: Record<string, string> = {}) => send('POST', '/api/add', { headers: { ...good(), ...h }, body: JSON.stringify(body) });
  it('needs the token and the own origin, takes exactly {url}, and passes it to the add code', async () => {
    expect((await add({ url: 'https://example.test/job/1' }, { 'x-job-radar-token': 'x' })).status).toBe(403);
    expect((await add({ url: 'https://example.test/job/1' }, { origin: 'https://evil.example' })).status).toBe(403);
    for (const b of [{}, { url: 5 }, { url: 'https://e.test', key: 'x' }, { url: 'x'.repeat(2001) }, ['https://e.test']]) expect((await add(b)).status).toBe(400);
    expect(added).toEqual([]);
    const r = await add({ url: ' https://example.test/job/1 ' }); expect(r.status).toBe(200); expect(added).toEqual(['https://example.test/job/1']);
    expect((await send('GET', '/api/add')).status).toBe(405);
  });
  it('the dashboard box sends the link with the token and shows the result', async () => {
    const page = await (await browser.newContext()).newPage(); await page.goto(d.url); await page.waitForSelector('tbody tr');
    await page.fill('#add-url', 'https://jobs.example.test/role/42'); await page.click('#add-go');
    await page.waitForFunction(() => /added/.test(document.getElementById('addmsg')!.textContent!)); expect(added).toEqual(['https://jobs.example.test/role/42']);
    await page.close();
  });
});

describe('another website open in the same browser cannot launch anything', () => {
  it('cross-origin fetch (cors and no-cors) and a cross-origin form post all fail to start a run', async () => {
    const evil = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<!doctype html><form id=f method=POST action="http://127.0.0.1:${d.port}/api/launch" enctype="text/plain"><input name='{"keys":["lever:1"],"x":"' value='"}'></form>`); });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r)); const ep = (evil.address() as any).port;
    const page = await (await browser.newContext()).newPage(); await page.goto(`http://127.0.0.1:${ep}/`);
    const out = await page.evaluate(async (u) => {
      const res: string[] = [];
      try { const r = await fetch(u + 'api/launch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-job-radar-token': 'guess' }, body: '{"keys":["lever:1"]}' }); res.push('cors:' + r.status); } catch (e) { res.push('cors:blocked'); }
      try { await fetch(u + 'api/launch', { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{"keys":["lever:1"]}' }); res.push('nocors:sent'); } catch { res.push('nocors:blocked'); }
      try { const html = await (await fetch(u)).text(); res.push('read-token:' + html.length); } catch { res.push('read-token:blocked'); }   // reading the page (to steal the token) is blocked by the same-origin policy
      return res;
    }, d.url);
    expect(out).toContain('cors:blocked'); expect(out).toContain('read-token:blocked');
    await page.evaluate(() => (document.getElementById('f') as HTMLFormElement).requestSubmit()).catch(() => {}); await page.waitForTimeout(500);
    expect(starts).toEqual([]);
    await page.close(); evil.close();
  });
});

it('checkWrite is the single gate (unit)', () => {
  const req = (h: Record<string, string>, method = 'POST') => ({ method, headers: h }) as any;
  const ok = { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9', 'content-type': 'application/json', 'x-job-radar-token': 't'.repeat(64) };
  expect(checkWrite(req(ok), 9, 't'.repeat(64))).toBeNull();
  expect(checkWrite(req({ ...ok, host: 'localhost:9', origin: 'http://localhost:9' }), 9, 't'.repeat(64))).toBeNull();
  expect(checkWrite(req({ ...ok, origin: 'http://localhost:9' }), 9, 't'.repeat(64))).toBeNull();   // the page may be opened as localhost or 127.0.0.1
  expect(checkWrite(req(ok, 'GET'), 9, 't'.repeat(64))?.code).toBe(405);
  expect(checkWrite(req({ ...ok, 'sec-fetch-site': 'same-site' }), 9, 't'.repeat(64))?.code).toBe(403);
});
