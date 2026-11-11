import { USER_AGENT } from '../config.js';

const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** URL without query string or fragment: safe to put in errors and logs (api keys often ride in the query). */
export function redactUrl(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url).split(/[?#]/)[0]; }
}

export interface FeedFetchOpts { headers?: Record<string, string>; retries?: number; minGapMs?: number; accept?: string }

/** GET with extra headers allowed. Same policy as src/http.ts: 1 request/second/host, retries with backoff on 429/5xx/network errors,
 * the named User-Agent from config (callers may override it, e.g. USAJobs wants the registered email). Errors never contain the query string. */
export async function feedFetch(url: string, opts: FeedFetchOpts = {}): Promise<Response> {
  const host = new URL(url).host;
  const gap = opts.minGapMs ?? 1000;
  const retries = opts.retries ?? 3;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: opts.accept ?? 'application/json', ...(opts.headers ?? {}) };
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = (e as Error)?.message ?? 'network error';
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`fetch failed for ${redactUrl(url)}: ${lastErr.split(url).join(redactUrl(url))}`);
}
