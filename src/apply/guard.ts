import type { Page, Locator, BrowserContext } from 'playwright';
import { USER_AGENT } from '../config.js';
import { lockdownAutomation } from './lockdown.js';

/** HARD LIMITS (enforced here, tested in tests/apply.test.ts):
 *  - nothing that looks like a submit/apply/send control is ever clicked (safeClick throws);
 *  - every network request that is not GET/HEAD is aborted, and form `submit` events are cancelled and counted;
 *  - no password typing, no Enter key presses, no account creation;
 *  - at most one navigation per host per second, with a User-Agent that names the tool. */
import { SubmitGuardError } from './errors.js';
export { SubmitGuardError };

const SUBMITTY = /^\s*(submit|apply|send|finish|complete|confirm|continue to apply|sign\s?up|create account|register)\b/i;

export async function isSubmitLike(loc: Locator): Promise<boolean> {
  return loc.evaluate((el, src) => {
    const re = new RegExp(src, 'i');
    const e = el as HTMLElement & { type?: string; form?: HTMLFormElement | null };
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') || '').toLowerCase();
    const text = (e.textContent || e.getAttribute('value') || e.getAttribute('aria-label') || '').trim();
    if (type === 'submit' || type === 'image') return true;
    if (tag === 'button' && !e.getAttribute('type') && e.form) return true;  // a <button> without type defaults to submit INSIDE a form. With no form owner it cannot submit natively (Ashby's Yes/No answer buttons); its text is still checked below, so "Submit Application" stays blocked
    if ((e.getAttribute('data-qa') || '').includes('submit') || /submit/i.test(e.id || '')) return true;
    return re.test(text);
  }, SUBMITTY.source);
}

/** The ONLY way this codebase clicks anything. Refuses submit-like controls. */
export async function safeClick(loc: Locator, why: string): Promise<void> {
  if (await isSubmitLike(loc)) throw new SubmitGuardError(`refusing to click a submit-like control (${why})`);
  await loc.click({ timeout: 5000 });
}

const lastNav = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ONLY non-GET requests ever let through: Ashby's read-only GraphQL queries that render the application page (posting, org, location autocomplete).
 *  Ashby's hosted pages load their form with POST, so blocking all POSTs made every Ashby form fail to render. Everything else stays blocked, and any body containing
 *  "mutation" (how a submission would be sent) is blocked even on an allowed op name. The Submit button is separately unclickable (safeClick). */
export const ASHBY_READ_OPS = new Set(['ApiOrganizationFromHostedJobsPageName', 'ApiJobPosting', 'ApiAutocompleteGeoLocation', 'ApiJobBoardWithTeams', 'ApiJobPostingWithForm']);
export function isAllowedReadPost(method: string, url: string, body: string | null | undefined): boolean {
  let u: URL; try { u = new URL(url); } catch { return false; }
  // Greenhouse uploads the attached resume/cover letter to its own presigned S3 bucket as soon as the file is chosen; until that finishes the form shows an endless loading bar
  // and holds no resume. This is the file upload only, not the application (the application is posted to boards-api / the form action, which stays blocked).
  if (['POST', 'PUT'].includes(method.toUpperCase()) && u.protocol === 'https:' && /^grnhse-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com$/.test(u.host) && /^\/[A-Za-z0-9_\-./%]*$/.test(u.pathname) && !/mutation/i.test(body ?? '')) return true;
  if (method.toUpperCase() !== 'POST') return false;
  if (u.protocol !== 'https:' || u.host !== 'jobs.ashbyhq.com' || u.pathname !== '/api/non-user-graphql') return false;
  const op = u.searchParams.get('op') ?? '';
  if (!ASHBY_READ_OPS.has(op)) return false;
  if (/mutation/i.test(body ?? '')) return false;
  try { if (JSON.parse(body ?? '{}').operationName !== op) return false; } catch { return false; }
  return true;
}

/** Call once per context before any page is opened. */
export interface Guards { blocked: string[]; ctx: BrowserContext; handler: (route: import('playwright').Route) => Promise<void> }
/** Pages whose NETWORK + in-page guards were lifted by handoff(). The tool performs no further actions on them. */
export const LIFTED = new WeakSet<object>();
export async function installGuards(ctx: BrowserContext, opts: { allowOnly?: (url: URL) => boolean } = {}): Promise<Guards> {
  const blocked: string[] = [];
  await ctx.addInitScript(() => {
    // tsx/esbuild wraps named arrow functions with a __name() helper that does not exist inside the page; shim it so page.evaluate callbacks run from the CLI too
    (window as any).__name = (f: unknown) => f;
    if ((window as any).__jrHandedOff) return;   // HANDOFF phase: the human is in charge of this tab, install nothing (the handoff script sets this flag; either script order works)
    (window as any).__jrBlockedSubmits = 0;
    const onSubmit = (e: Event) => { (window as any).__jrBlockedSubmits++; e.preventDefault(); e.stopImmediatePropagation(); };
    (window as any).__jrOrig = { submit: HTMLFormElement.prototype.submit, requestSubmit: HTMLFormElement.prototype.requestSubmit };
    (window as any).__jrOnSubmit = onSubmit;
    window.addEventListener('submit', onSubmit, true);
    HTMLFormElement.prototype.submit = function () { (window as any).__jrBlockedSubmits++; };
    HTMLFormElement.prototype.requestSubmit = function () { (window as any).__jrBlockedSubmits++; };
  });
  const handler = async (route: import('playwright').Route) => {
    const req = route.request();
    try { if (LIFTED.has(req.frame().page())) return route.fallback(); } catch { /* no frame (service worker etc.): stays guarded */ }   // HANDOFF phase: this tab is the human's, its requests pass untouched
    const u = new URL(req.url());
    const m = req.method().toUpperCase();
    if (m !== 'GET' && m !== 'HEAD' && !isAllowedReadPost(m, req.url(), req.postData())) { blocked.push(`${m} ${req.url()}`); return route.abort('blockedbyclient'); }   // nothing is ever sent
    if (opts.allowOnly && !opts.allowOnly(u)) { blocked.push(`GET(not allowed) ${req.url()}`); return route.abort('blockedbyclient'); }
    if (req.resourceType() === 'document' && /^https?:$/.test(u.protocol)) {   // 1 navigation per second per host
      const wait = (lastNav.get(u.host) ?? 0) + 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      lastNav.set(u.host, Date.now());
    }
    return route.continue({ headers: { ...req.headers(), 'user-agent': USER_AGENT } });
  };
  await ctx.route('**/*', handler);
  lockdownAutomation(ctx);
  const g: Guards = { blocked, ctx, handler };
  (ctx as any).__jrGuards = g;
  return g;
}

export async function blockedSubmitCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__jrBlockedSubmits ?? 0).catch(() => 0);
}
