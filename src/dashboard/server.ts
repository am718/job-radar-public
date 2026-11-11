import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import { openDb } from '../store.js';
import { markJob, isMarkStatus } from '../marking.js';
import { byHandFiles, PREPARED_DIR } from '../apply/byfiles.js';
import { loadAnswers } from '../apply/answers.js';
import { buildSheet } from '../apply/sheet.js';
import { remainingToday, dailyCap, etDate } from '../apply/queue.js';
import { minScore } from '../apply/prepare.js';
import { jobRows, jobDetail, statsFromDb } from './data.js';
import { renderPage } from './page.js';
import { checkWrite, hostOk, readJson, newToken, KEY_RE } from './security.js';
import { validateLaunch, type Launcher } from './launch.js';
import { createLauncher } from './runs.js';
import { addJobFromUrl, type AddResult } from '../ingest/add.js';
import { realFetch } from '../ingest/net.js';
import type { LlmFn } from '../scoring/scorer.js';

// LOCAL DASHBOARD. Listens on 127.0.0.1 ONLY (there is deliberately no host option: it can never be bound to 0.0.0.0 or a LAN address).
// Reads data/jobs.db through a READ-ONLY connection. Writes happen only through POST endpoints, every one of which passes checkWrite()
// (Host + Origin + Sec-Fetch-Site + JSON content type + a random per-process token that only the dashboard page knows):
//   POST /api/mark   {key, status}          -> markJob(), same as `npm run mark`
//   POST /api/launch {keys, allowLowFit?}   -> prepare runs in a visible browser on this machine, same code as `npm run prepare` (submit guard + handoff unchanged)
//   POST /api/focus  {key}                  -> bring that prepared window to the front
//   POST /api/add    {url}                  -> addJobFromUrl(): fetch that public job page (never LinkedIn/Indeed/Handshake, never a private/IP host), score it, store it
// No request can pass a URL, path, command or option to the browser: only job keys, which must exist in the database.
// No external requests: the page is self-contained and a Content-Security-Policy forbids any.
export const HOST = '127.0.0.1';
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', 'x-frame-options': 'DENY' };
const WRITE_PATHS = new Set(['/api/mark', '/api/launch', '/api/focus', '/api/add']);

export interface Dashboard { server: http.Server; port: number; url: string; reader: Database.Database; token: string; launcher: Launcher; close(): Promise<void> }

export type AddFn = (db: Database.Database, url: string) => Promise<AddResult>;
export async function startDashboard(o: { dbPath?: string; port?: number; preparedDir?: string; launcher?: Launcher; token?: string; answersFile?: string; addJob?: AddFn } = {}): Promise<Dashboard> {
  const file = o.dbPath ?? process.env.JOB_RADAR_DB ?? DB_PATH;
  const dir = o.preparedDir ?? PREPARED_DIR();
  const writer = openDb(file);                          // creates/updates tables exactly as every other command does; used ONLY by the POST endpoints and the prepare runs
  const reader = new Database(file, { readonly: true, fileMustExist: true });
  const token = o.token ?? newToken();
  const launcher = o.launcher ?? createLauncher({ db: writer, preparedDir: dir, answersFile: o.answersFile });
  const send = (res: http.ServerResponse, code: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': type, ...SEC, ...extra }); res.end(body); };
  const json = (res: http.ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v));
  const exists = (key: string) => KEY_RE.test(key) && !!reader.prepare('SELECT 1 FROM jobs WHERE key=?').get(key);
  const inside = (p: string) => { const r = path.resolve(p), d = path.resolve(dir) + path.sep; return r.startsWith(d); };

  let adding = false;
  const defaultAdd: AddFn = async (db, url) => {   // the same code as `npm run add -- <url>`; scoring goes through the monthly spend cap
    let llm: LlmFn | null = null; try { llm = (await import('../spend.js')).budgetedLlm('FEED', 'add link'); } catch { llm = null; }
    return addJobFromUrl(db, url, { fetch: realFetch, llm });
  };
  async function write(req: http.IncomingMessage, res: http.ServerResponse, route: string, port: number) {
    const refused = checkWrite(req, port, token); if (refused) return json(res, refused.code, { error: refused.error });
    const body = await readJson(req); if (body === undefined) return json(res, 400, { error: 'bad JSON' });
    if (route === '/api/mark') {
      const { key, status } = body ?? {};
      if (typeof key !== 'string' || !isMarkStatus(status)) return json(res, 400, { error: 'need {key, status: applied|skip}' });
      const r = markJob(writer, key, status, 'dashboard'); if (!r.ok) return json(res, 404, { error: 'no such job' });
      return json(res, 200, { ok: true, key, status, changed: r.changed, was: r.was });
    }
    if (route === '/api/launch') {
      const today = etDate();
      const preparedToday = (k: string) => !!writer.prepare('SELECT 1 FROM prep_queue WHERE key=? AND prepared_at IS NOT NULL').get(k) && etDate((writer.prepare('SELECT prepared_at p FROM prep_queue WHERE key=?').get(k) as { p: string }).p) === today;
      const v = validateLaunch(writer, body, launcher, { minScore: minScore(), remainingToday: remainingToday(writer, today, dailyCap()), preparedToday });
      if (!v.ok) return json(res, v.code, { error: v.error, keys: v.keys });
      launcher.start(v.keys, { allowLowFit: body.allowLowFit === true });
      return json(res, 202, { ok: true, started: v.keys });
    }
    if (route === '/api/add') {
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
      if (!keys || keys.length !== 1 || typeof body.url !== 'string' || body.url.length > 2000) return json(res, 400, { error: 'need {url}' });
      if (adding) return json(res, 429, { error: 'one link at a time' });
      adding = true;
      try { const r = await (o.addJob ?? defaultAdd)(writer, body.url.trim()); return json(res, r.status === 'failed' ? 502 : r.status === 'refused' ? 422 : 200, r); }
      finally { adding = false; }
    }
    if (route === '/api/focus') {
      const key = body?.key; if (typeof key !== 'string' || !exists(key)) return json(res, 404, { error: 'no such job' });
      return (await launcher.focus(key)) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'no open window for this job' });
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    (async () => {
      const port = (server.address() as { port: number }).port;
      if (!hostOk(req, port)) return json(res, 403, { error: 'bad host' });
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (WRITE_PATHS.has(u.pathname)) return req.method === 'POST' ? write(req, res, u.pathname, port) : json(res, 405, { error: 'POST only' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read-only: only GET, plus the token-checked POST endpoints' });
      if (u.pathname === '/' || u.pathname === '/index.html') return send(res, 200, renderPage({ mode: 'dashboard', title: 'job-radar (local dashboard)', token }), 'text/html; charset=utf-8');
      if (u.pathname === '/api/jobs') return json(res, 200, jobRows(reader));
      if (u.pathname === '/api/stats') return json(res, 200, statsFromDb(reader));
      if (u.pathname === '/api/runs') return json(res, 200, launcher.list());
      if (u.pathname === '/api/job') { const d = jobDetail(reader, u.searchParams.get('key') ?? '', dir); return d ? json(res, 200, d) : json(res, 404, { error: 'no such job' }); }
      if (u.pathname === '/letter') {      // the letter PDF is found from the job key through prepared/'s .job marker; a client-supplied path is never used
        const key = u.searchParams.get('key') ?? ''; if (!exists(key)) return json(res, 404, { error: 'no such job' });
        const p = byHandFiles(key, dir).letterPdf; if (!p || !fs.existsSync(p)) return json(res, 404, { error: 'no letter' });
        return send(res, 200, fs.readFileSync(p), 'application/pdf', { 'content-disposition': 'inline' });
      }
      if (u.pathname === '/shot') {        // screenshot of the filled form: path from the DB (or the standard name), and it must lie inside the prepared folder
        const key = u.searchParams.get('key') ?? ''; if (!exists(key)) return json(res, 404, { error: 'no such job' });
        const row = reader.prepare('SELECT screenshot FROM prep_queue WHERE key=?').get(key) as { screenshot: string | null } | undefined;
        const [src, ...rest] = key.split(':'); const std = path.join(dir, `${src}-${rest.join(':')}-form.png`);
        const p = [row?.screenshot, std].find((x) => x && x.endsWith('.png') && inside(x) && fs.existsSync(x));
        return p ? send(res, 200, fs.readFileSync(p), 'image/png') : json(res, 404, { error: 'no screenshot' });
      }
      if (u.pathname === '/api/sheet') {   // copy-ready answers + letter for apply-by-hand (blocked sites); same text as `npm run sheet`
        const key = u.searchParams.get('key') ?? ''; if (!exists(key)) return json(res, 404, { error: 'no such job' });
        try { return send(res, 200, buildSheet(reader, key, loadAnswers(o.answersFile ?? 'answers.json'), dir), 'text/plain; charset=utf-8'); }
        catch (e) { return json(res, 404, { error: (e as Error).message.split('\n')[0] }); }
      }
      return json(res, 404, { error: 'not found' });
    })().catch(() => { try { json(res, 500, { error: 'server error' }); } catch { /* already sent */ } });
  });
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(o.port ?? 0, HOST, r); });   // HOST is a constant: loopback only
  const port = (server.address() as { port: number }).port;
  return { server, port, url: `http://${HOST}:${port}/`, reader, token, launcher, close: () => new Promise<void>((r) => { server.close(async () => { await launcher.close().catch(() => {}); reader.close(); writer.close(); r(); }); server.closeAllConnections?.(); }) };
}

if (process.argv[1]?.endsWith('server.ts')) {
  const port = Number(process.env.DASHBOARD_PORT ?? 4173);
  startDashboard({ port }).then((d) => console.log(`job-radar dashboard: ${d.url}  (127.0.0.1 only; reads are read-only; writes need the page's token: mark applied/skip, Open and fill). Ctrl+C to stop.`)).catch((e) => { console.error(e.message); process.exit(1); });
}
