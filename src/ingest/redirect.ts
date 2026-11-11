import { USER_AGENT } from '../config.js';
import { isForbiddenHost, urlRefusal } from './hosts.js';
import type { FetchFn } from './net.js';

export interface RedirectResult {
  /** The last URL we had: the final destination, or the last URL before a refused hop. */
  url: string;
  hops: number;
  /** A hop pointed at a forbidden host (or the start URL was forbidden): it was NOT requested. */
  skippedForbidden: boolean;
  /** Why we stopped: done = reached a non-redirect, forbidden / unsafe / invalid = refused hop, max-hops, error. */
  /** The refused hop's target (never requested). Lets the caller keep a forbidden job URL as plain text. */
  blockedUrl?: string;
  stopped: 'done' | 'forbidden' | 'unsafe' | 'invalid' | 'max-hops' | 'error';
}

/** Follows a plain HTTP redirect chain (Location header only, no JS/meta refresh, no cookies). Never sends a request to a forbidden host. */
export async function resolveRedirect(url: string, opts: { fetch: FetchFn; maxHops?: number }): Promise<RedirectResult> {
  const maxHops = opts.maxHops ?? 5;
  let cur = url, hops = 0;
  const refuse = (target: string): RedirectResult | null => {
    const r = urlRefusal(target);
    return r ? { url: cur, hops, skippedForbidden: r.kind === 'forbidden', blockedUrl: r.kind === 'forbidden' ? target : undefined, stopped: r.kind } : null;
  };
  const first = refuse(cur);
  if (first) return first;
  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*' };
  while (true) {
    let res: Response;
    try {
      res = await opts.fetch(cur, { method: 'HEAD', headers, redirect: 'manual' });
      if (res.status === 405) res = await opts.fetch(cur, { method: 'GET', headers, redirect: 'manual' });
    } catch { return { url: cur, hops, skippedForbidden: false, stopped: 'error' }; }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    try { res.body?.cancel(); } catch { /* ignore */ }
    if (!loc) return { url: cur, hops, skippedForbidden: false, stopped: 'done' };
    let next: string;
    try { next = new URL(loc, cur).toString(); } catch { return { url: cur, hops, skippedForbidden: false, stopped: 'invalid' }; }
    const bad = refuse(next);
    if (bad) return bad;
    if (hops >= maxHops) return { url: cur, hops, skippedForbidden: false, stopped: 'max-hops' };
    cur = next; hops++;
  }
}
export { isForbiddenHost };
