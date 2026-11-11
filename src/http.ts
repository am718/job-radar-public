import { USER_AGENT } from './config.js';

const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1 request/second/host, retry with exponential backoff on 429/5xx/network errors. */
export async function politeFetch(url: string, opts: { retries?: number; minGapMs?: number } = {}): Promise<Response> {
  const host = new URL(url).host;
  const gap = opts.minGapMs ?? 1000;
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`fetch failed for ${url}: ${(lastErr as Error)?.message}`);
}
