import type { Page } from 'playwright';
import { LIFTED, type Guards } from './guard.js';
import { classify } from './protection.js';
import { submissionSucceeded, confirmationPage } from './submitted.js';

// HANDOFF phase. After a tab is fully prepared and verified (and its screenshot is taken) the tool lifts the submit-blocking guards for THAT tab and then performs
// no further action on it: no clicks, no keypresses, no evaluate (the lockdown wrapper throws HandoffError if any code tries). It only waits for the window to close.
// What is lifted: (1) the network block on non-GET requests, (2) the in-page layer (the capturing `submit` listener and the form.submit()/requestSubmit() stubs).
// What is NOT lifted: the automation wrapper (lockdown.ts). The tool still cannot click Submit, press Enter or call form.submit() in either phase.
export const HANDOFF_LINE = 'Handoff: the network guard is lifted. The tool will not touch this page again. Review and click Submit yourself.';

// Runs inside the page (one last evaluate per frame, then never again). Works in either order with the guard's own init script, which skips installing when the flag is set.
const RESTORE = `(() => { try { window.__jrHandedOff = true; if (window.__jrOnSubmit) window.removeEventListener('submit', window.__jrOnSubmit, true); var o = window.__jrOrig; if (o) { HTMLFormElement.prototype.submit = o.submit; HTMLFormElement.prototype.requestSubmit = o.requestSubmit; } } catch (e) {} })()`;

export async function handoff(page: Page, guards: Guards, o: { key: string; log?: (s: string) => void; keepRoute?: boolean; onSubmitted?: (key: string, evidence: string) => void }): Promise<void> {
  const log = o.log ?? console.log;
  await page.addInitScript({ content: RESTORE });                                     // every future document in this tab (after the submit navigates, etc.)
  for (const f of page.frames()) await f.evaluate(RESTORE).catch(() => {});           // the documents that are open right now (main page + embedded form iframes)
  LIFTED.add(page);                                                                   // network: this tab's requests now bypass the guard route
  // keepRoute: batch runs keep opening tabs after earlier ones are handed off, so the route stays (lifted tabs fall through it); a new tab is guarded from its first request
  if (!o.keepRoute && guards.ctx.pages().every((p) => LIFTED.has(p))) await guards.ctx.unroute('**/*', guards.handler);   // last guarded tab handed off: remove the route entirely
  watchSubmission(page, log, o.key, o.onSubmitted);
  log(`${HANDOFF_LINE}\n   When you submit it yourself, the tool notices the ATS's success reply and marks it applied (or: npm run mark -- ${o.key} applied)`);
}

/** reCAPTCHA's own housekeeping calls (clr, reload, ...) fail or are cancelled all the time, with or without a submit: they are not submit failures. */
export const isCaptchaHousekeeping = (url: string) => /^https?:\/\/([a-z0-9-]+\.)*(google|gstatic|recaptcha)\.(com|net)\/recaptcha\/(api2|enterprise)?\/?(clr|reload|userverify|webworker|bframe|anchor|logo)\b/i.test(url) || /^https?:\/\/([a-z0-9-]+\.)*google\.com\/recaptcha\/.*\/(clr|reload)(\?|$)/i.test(url);

/** Prints each DISTINCT failure once per tab, with a count, instead of one line per repeat. The first line comes after a short quiet window (so the count is real); later repeats are summed into one follow-up line. */
export function dedupedLog(log: (s: string) => void, flushMs = 1200) {
  const seen = new Map<string, { n: number; printed: number; timer: NodeJS.Timeout | null; line: () => string }>();
  const flush = (k: string) => {
    const e = seen.get(k)!; e.timer = null;
    if (!e.printed) log(`${e.line()}${e.n > 1 ? `  [seen ${e.n} times]` : ''}`);
    else log(`   (same failure repeated ${e.n - e.printed} more time(s), ${e.n} in total): ${k}`);
    e.printed = e.n;
  };
  return {
    record(k: string, line: () => string) {
      let e = seen.get(k); if (!e) { e = { n: 0, printed: 0, timer: null, line }; seen.set(k, e); }
      e.n++; e.line = line;
      if (!e.timer) { e.timer = setTimeout(() => flush(k), flushMs); e.timer.unref?.(); }
    },
    flushAll() { for (const [k, e] of seen) { if (e.timer) clearTimeout(e.timer); if (e.n > e.printed) flush(k); } },
  };
}

/** Passive diagnostics only (event listeners, no page actions). If YOUR submit fails, the cause is printed to the terminal: status + body size of the failed application request, and whether a captcha / email-verification / WAF challenge showed up. Never solves or evades anything. */
function watchSubmission(page: Page, rawLog: (s: string) => void, key: string, onSubmitted?: (key: string, evidence: string) => void) {
  const dl = dedupedLog(rawLog);
  let done = false; const submitted = (why: string) => { if (done || !onSubmitted) return; done = true; onSubmitted(key, why); };   // once per tab
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) { const why = confirmationPage(f.url()); if (why) submitted(why); } });
  (page as any).__jrFlushFailures = () => dl.flushAll();
  const safe = (u: string) => u.replace(/[?#].*$/, '');
  const verdict = (extra: { status?: number; headers?: Record<string, string>; body?: string }) => {
    const c = classify({ status: extra.status, headers: extra.headers, body: extra.body, blockedRequests: page.frames().map((f) => f.url()) });
    const verify = /verification code|verify your email|confirm your email/i.test(extra.body ?? '');
    const frames = page.frames().map((f) => f.url()).filter((u) => /recaptcha|hcaptcha|turnstile|captcha-delivery|awswaf|challenges\.cloudflare/i.test(u));
    return `challenge: ${c.protected ? `${c.vendor} (${c.reason})` : 'no WAF/bot-check signal in the response'}; captcha frame on page: ${frames.length ? frames.map(safe).join(', ') : 'no'}; email-verification wording in the response: ${verify ? 'YES' : 'no'}`;
  };
  page.on('response', async (res) => {
    const req = res.request(); const m = req.method();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
    if (isCaptchaHousekeeping(req.url())) return;
    const status = res.status(); const headers = res.headers();
    if (onSubmitted && !done && status < 400) {   // success path: read the body only for the ATS submit endpoints
      let body: string | undefined; if (/ashbyhq\.com/.test(req.url())) { try { body = (await res.body()).toString('utf8').slice(0, 50_000); } catch { /* gone */ } }
      const why = submissionSucceeded({ method: m, url: req.url(), status, location: headers.location, body }); if (why) submitted(why);
    }
    if (status < 400 && !headers['x-amzn-waf-action'] && !headers['cf-mitigated']) return;
    let body = ''; try { body = (await res.body()).toString('utf8').slice(0, 200_000); } catch { /* body gone */ }
    dl.record(`${m} ${safe(req.url())} HTTP ${status}`, () => `!! [${key}] your submit's request failed: ${m} ${safe(req.url())} -> HTTP ${status}, response body ${body.length} bytes. ${verdict({ status, headers, body })}. (reported only; the tool does not try to get past any challenge)`);
  });
  page.on('requestfailed', (req) => {
    const m = req.method(); if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || isCaptchaHousekeeping(req.url())) return;
    const why = req.failure()?.errorText ?? 'failed';
    dl.record(`${m} ${safe(req.url())} ${why}`, () => `!! [${key}] your submit's request never got a response: ${m} ${safe(req.url())} -> ${why}. ${verdict({})}`);
  });
}
