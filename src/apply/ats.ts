import type { Page } from 'playwright';
import type { Ats } from '../types.js';

/** Where the application form lives. Greenhouse: the job page itself contains the form. Lever: <job url>/apply. Ashby: <job url>/application. */
/** Greenhouse postings often link to the company's own careers page (e.g. careers.toasttab.com/jobs?gh_jid=123) which has no form of its own; the real form is always at
 *  job-boards.greenhouse.io/<board>/jobs/<id>, and the board slug is the one we scan in companies.json. */
export function canonicalGreenhouseUrl(jobUrl: string, id: string, slug: string | null | undefined): string {
  let host = ''; try { host = new URL(jobUrl).host; } catch { /* keep as is */ }
  if (/(^|\.)greenhouse\.io$/.test(host) || !slug || !/^\d+$/.test(id)) return jobUrl;
  return `https://job-boards.greenhouse.io/${slug}/jobs/${id}`;
}
export function applyUrl(source: Ats, jobUrl: string): string {
  const u = jobUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (source === 'lever') return u.endsWith('/apply') ? u : `${u}/apply`;
  if (source === 'ashby') return u.endsWith('/application') ? u : `${u}/application`;
  return jobUrl;                                                          // greenhouse keeps its query (gh_jid) if any
}
/** Selector that tells us the form has rendered. */
export const READY: Record<Ats, string> = { greenhouse: 'form input, form textarea', lever: 'form#application-form input[name="name"]', ashby: 'input[type="email"], input[type="file"]' };   // Ashby renders the application after GraphQL calls; plain `input` matched a transient error shell

export async function waitForForm(page: Page, source: Ats, timeout = 15000): Promise<boolean> {
  const ok = await page.locator(READY[source]).first().waitFor({ state: 'attached', timeout }).then(() => true, () => false);
  if (ok) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});   // let the rest of the form (Ashby questions/EEO, company-hosted Greenhouse embeds) finish rendering before it is read
  return ok;
}
