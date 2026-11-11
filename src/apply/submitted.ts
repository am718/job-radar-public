// Recognises, from what the browser's network already showed, that the OWNER's own submit was ACCEPTED by the ATS. Purely passive: it looks at a response (method, url, status, a few headers, maybe the body)
// and never clicks, types, or touches the page. Used after handoff so a job the owner applied to gets marked applied without a manual step.
// Best effort by design: when the response is not clearly a success this returns null, and the owner still has the Applied button / `npm run mark`.
export interface Seen { method: string; url: string; status: number; location?: string; body?: string }

const NOISE = /(recaptcha|gstatic|google-analytics|googletagmanager|doubleclick|sentry|segment|datadog|amazonaws\.com|hcaptcha|cloudflare|awswaf)/i;
const DONE_PAGE = /\/(thanks?|thank-you|confirmation|application[-_/]?(success|submitted|confirmation|complete))(\/|\?|#|$)/i;

/** A one-line reason ("Ashby accepted the application") when the response is a success for an application submit, else null. */
export function submissionSucceeded(r: Seen): string | null {
  const m = r.method.toUpperCase();
  let u: URL; try { u = new URL(r.url); } catch { return null; }
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || u.protocol !== 'https:' || NOISE.test(u.host)) return null;
  const ok2 = r.status >= 200 && r.status < 300, redirect = r.status >= 300 && r.status < 400;
  const host = u.host.toLowerCase();
  if (host === 'jobs.ashbyhq.com' && u.pathname === '/api/non-user-graphql') {
    if (!/^ApiSubmit/i.test(u.searchParams.get('op') ?? '') || !ok2) return null;
    const b = r.body ?? '';
    if (!b || /"errors"\s*:\s*\[\s*\{/.test(b) || /(error|fail|invalid|spam|captcha|denied)/i.test(b)) return null;   // anything that reads like a refusal is NOT a success
    return 'Ashby accepted the application';
  }
  if (/(^|\.)greenhouse\.io$/.test(host) && m === 'POST' && /\/(jobs\/\d+|applications?|job_app)\b/i.test(u.pathname)) {
    if (ok2) return /(error|invalid|can't be blank|captcha)/i.test(r.body ?? '') ? null : 'Greenhouse accepted the application';
    if (redirect && DONE_PAGE.test(r.location ?? '')) return 'Greenhouse redirected to its confirmation page';
    return null;
  }
  if (/(^|\.)lever\.co$/.test(host) && m === 'POST' && /\/apply\/?$/i.test(u.pathname)) {
    if (redirect && DONE_PAGE.test(r.location ?? '')) return 'Lever redirected to its thank-you page';
    if (ok2 && !/(error|invalid|captcha)/i.test(r.body ?? '')) return 'Lever accepted the application';
  }
  return null;
}
/** The tab itself landed on an ATS confirmation page (works for the redirect style of Greenhouse and Lever). */
export function confirmationPage(url: string): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  return /(greenhouse\.io|lever\.co|ashbyhq\.com)$/i.test(u.host) && DONE_PAGE.test(u.pathname) ? `${u.host} confirmation page` : null;
}
