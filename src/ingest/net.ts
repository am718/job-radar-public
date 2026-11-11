import { USER_AGENT } from '../config.js';

export type FetchInit = { method?: string; headers?: Record<string, string>; redirect?: 'manual' | 'follow' | 'error'; signal?: AbortSignal };
/** Injectable fetch; globalThis.fetch satisfies it. */
export type FetchFn = (url: string, init?: FetchInit) => Promise<Response>;

const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Real network fetch: 1 request/second/host, 20s timeout, no cookies are ever sent or stored. */
export const realFetch: FetchFn = async (url, init = {}) => {
  const host = new URL(url).host, wait = (lastHit.get(host) ?? 0) + 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
};
export const jsonHeaders = () => ({ 'User-Agent': USER_AGENT, Accept: 'application/json' });
export const htmlHeaders = () => ({ 'User-Agent': USER_AGENT, Accept: 'text/html' });
