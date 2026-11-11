import type { Page } from 'playwright';

export interface Blocker { kind: 'captcha' | 'login' | 'email_verification' | 'closed'; detail: string }

/** Looks for things this tool must never work around. If found, the run stops and tells the owner. */
export async function detectBlocker(page: Page): Promise<Blocker | null> {
  return page.evaluate(() => {
    const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(el as HTMLElement); return r.width > 40 && r.height > 40 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const text = (document.body?.innerText || '').slice(0, 20000).toLowerCase();
    // visible captcha CHALLENGE (an invisible-captcha badge or hidden response field is not a challenge)
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      if (/(recaptcha\/api2\/(bframe|anchor)|hcaptcha\.com\/captcha|challenges\.cloudflare|arkoselabs|funcaptcha)/i.test(f.getAttribute('src') || '') && vis(f) && (f as HTMLElement).getBoundingClientRect().height > 100)
        return { kind: 'captcha' as const, detail: 'a visible captcha challenge is on the page' };
    }
    if (document.querySelector('.g-recaptcha:not([data-size="invisible"]), .h-captcha:not([data-size="invisible"]), [data-captcha-challenge]') && Array.from(document.querySelectorAll('.g-recaptcha, .h-captcha')).some((e) => vis(e) && (e as HTMLElement).getBoundingClientRect().height > 100))
      return { kind: 'captcha' as const, detail: 'a visible captcha widget is on the page' };
    if (/verify you are (a )?human|are you a robot|checking your browser|press (&|and) hold/.test(text)) return { kind: 'captcha' as const, detail: 'bot check page' };
    const visSmall = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const st = getComputedStyle(el as HTMLElement); return r.width > 10 && r.height > 5 && st.visibility !== 'hidden' && st.display !== 'none'; };
    const pw = Array.from(document.querySelectorAll('input[type=password]')).find(visSmall);
    if (pw || /(sign|log)\s?in to (apply|continue|submit)|please (sign|log) in|create an account to apply|you must be logged in/.test(text)) return { kind: 'login' as const, detail: pw ? 'a password field is on the page' : 'login wall text found' };
    if (/verify your email|enter the (verification )?code (we|that we) (sent|emailed)|verification code|confirm your email address/.test(text)) return { kind: 'email_verification' as const, detail: 'the page asks for email verification' };
    if (/no longer (accepting applications|available|open)|this (job|position|posting) (has been|is) (closed|filled)|job not found|page not found/.test(text)) return { kind: 'closed' as const, detail: 'the posting looks closed or missing' };
    return null;
  });
}
