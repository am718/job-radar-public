import crypto from 'node:crypto';
import type http from 'node:http';

// WRITE-REQUEST GATE for the local dashboard (written and reviewed by the orchestrator; see DECISIONS.md).
// The dashboard can start a browser, so every state-changing request must prove it comes from the dashboard page itself, on this machine:
//   1. the listening socket is 127.0.0.1 only (server.ts, constant HOST) -> other machines cannot connect;
//   2. Host header must be 127.0.0.1:<port> or localhost:<port> -> defeats DNS rebinding (a foreign name that resolves to 127.0.0.1);
//   3. Origin header must be present and be exactly this dashboard's origin -> another website's fetch/form is refused;
//   4. Sec-Fetch-Site, when the browser sends it, must be same-origin -> a second, browser-enforced signal for the same thing;
//   5. Content-Type must be application/json -> an HTML <form> cannot produce it, and cross-origin JSON needs a CORS preflight we never answer;
//   6. X-Job-Radar-Token must equal a random per-process token that is only ever written into the dashboard page -> a page on another
//      origin cannot read it (same-origin policy), so it cannot forge a request even if checks 3-5 were somehow bypassed.
// GET endpoints stay token-free: they change nothing, and other origins cannot read their responses (no CORS headers are ever sent).

export const TOKEN_HEADER = 'x-job-radar-token';
export const newToken = () => crypto.randomBytes(32).toString('hex');

/** Constant-time comparison; false for any missing / wrong-length / non-string value. */
export function tokenOk(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8'), b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const ownOrigins = (port: number) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
export const hostOk = (req: http.IncomingMessage, port: number) => { const h = String(req.headers.host ?? ''); return h === `127.0.0.1:${port}` || h === `localhost:${port}`; };

export interface Refusal { code: number; error: string }
/** Every POST goes through this. Returns null when the request may proceed, else the HTTP status and reason to send. */
export function checkWrite(req: http.IncomingMessage, port: number, token: string): Refusal | null {
  if (req.method !== 'POST') return { code: 405, error: 'POST only' };
  if (!hostOk(req, port)) return { code: 403, error: 'bad host' };
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !ownOrigins(port).includes(origin)) return { code: 403, error: 'bad origin' };
  const sfs = req.headers['sec-fetch-site'];
  if (sfs !== undefined && sfs !== 'same-origin') return { code: 403, error: 'cross-site request' };
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return { code: 415, error: 'send JSON' };
  if (!tokenOk(req.headers[TOKEN_HEADER], token)) return { code: 403, error: 'bad token' };
  return null;
}

/** Reads a small JSON body (10 KB max). Resolves undefined on oversize or bad JSON. */
export function readJson(req: http.IncomingMessage, max = 10_000): Promise<any> {
  return new Promise((resolve) => {
    let body = '', over = false;
    req.on('data', (c) => { if (over) return; body += c; if (body.length > max) { over = true; resolve(undefined); } });
    req.on('end', () => { if (over) return; try { resolve(JSON.parse(body || 'null')); } catch { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });
}

/** A job key as stored in the database: "<source>:<id>". Only this shape is ever accepted from a request; it is then looked up in the DB. */
export const KEY_RE = /^[a-z]{2,20}:[A-Za-z0-9._~-]{1,120}$/;
