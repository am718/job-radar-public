// Bot-protection DETECTION. This module only classifies what a page or response already showed us. It never tries to solve, wait out, or evade a challenge.
export interface Protection { protected: boolean; vendor: string | null; reason: string }
export interface Observed {
  status?: number;
  headers?: Record<string, string | undefined>;   // lower-case names; set-cookie may be joined with ", "
  body?: string;                                   // HTML (first ~300 KB is enough)
  requestedUrl?: string;
  finalUrl?: string;
  ats?: 'greenhouse' | 'lever' | 'ashby' | string;
  blockedRequests?: string[];                      // URLs the browser hit while loading (used after a prepare run)
}
const NO: Protection = { protected: false, vendor: null, reason: 'no bot-protection signal' };
const yes = (vendor: string, reason: string): Protection => ({ protected: true, vendor, reason });

/** Hosts a real application form lives on, per ATS. A redirect off these to a company careers page with no form means we cannot fill it. */
export const ATS_HOSTS: Record<string, RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/i,
  lever: /(^|\.)lever\.co$/i,
  ashby: /(^|\.)ashbyhq\.com$/i,
};

export function classify(o: Observed): Protection {
  const h = o.headers ?? {};
  const body = (o.body ?? '').slice(0, 300_000);
  const lower = body.toLowerCase();
  const st = o.status ?? 0;
  const cookies = (h['set-cookie'] ?? '').toLowerCase();
  const server = (h.server ?? '').toLowerCase();
  const blocked = (o.blockedRequests ?? []).join(' ').toLowerCase();
  const denied = st === 401 || st === 403 || st === 405 || st === 406 || st === 429 || st === 503;

  // AWS WAF: the challenge response carries x-amzn-waf-action (challenge/captcha), usually status 202 or 405, and loads the awswaf token script.
  const wafAction = (h['x-amzn-waf-action'] ?? '').toLowerCase();
  if (wafAction && wafAction !== 'allow' && wafAction !== 'count') return yes('AWS WAF', `x-amzn-waf-action: ${wafAction}${st ? ` (HTTP ${st})` : ''}`);
  if (/awswaf|aws-waf-token|\/challenge\.js.*awswaf|token\.awswaf\.com|\.awswaf\.com/.test(lower) || /awswaf/.test(blocked) || /aws-waf-token/.test(cookies)) {
    if (denied || st === 202 || !/<form[\s>]/.test(lower)) return yes('AWS WAF', `AWS WAF challenge script on the page${st ? ` (HTTP ${st})` : ''}`);
  }
  if (st === 405 && /awswaf|waf/.test(lower + blocked + JSON.stringify(h))) return yes('AWS WAF', 'HTTP 405 from the WAF');

  // Cloudflare: cf-mitigated header, or the interstitial text.
  if ((h['cf-mitigated'] ?? '').toLowerCase().includes('challenge')) return yes('Cloudflare', 'cf-mitigated: challenge');
  if (/just a moment\.\.\.|checking your browser before accessing|cf-browser-verification|challenge-platform\/h\/[a-z]\/orchestrate|id="challenge-form"|cf_chl_/.test(lower) && (denied || /<title>just a moment/.test(lower) || /cf-chl|challenge-platform/.test(lower))) return yes('Cloudflare', 'Cloudflare "Just a moment" challenge page');
  if (/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform/.test(blocked) && denied) return yes('Cloudflare', 'Cloudflare challenge requests');

  // DataDome / PerimeterX / Akamai: cookies and scripts alone are common on normal pages, so they only count with a block status or a challenge marker.
  if (/captcha-delivery\.com|geo\.captcha-delivery|datadome captcha/.test(lower + blocked) || (h['x-datadome'] || /datadome/.test(server)) && denied) return yes('DataDome', 'DataDome challenge');
  if (/px-captcha|perimeterx|human security|press (&amp;|&) hold|\/px\/captcha|px-cdn\.net.*captcha/.test(lower + blocked) && (denied || /px-captcha|press (&amp;|&) hold/.test(lower))) return yes('PerimeterX', 'PerimeterX / HUMAN challenge');
  if ((/_abck|ak_bmsc|bm_sz/.test(cookies) || /akamaighost|akamai/.test(server)) && denied) return yes('Akamai Bot Manager', `Akamai blocked the request (HTTP ${st})`);
  if (/errors\.edgesuite\.net|access denied.*reference #\d+\.[0-9a-f]+/.test(lower) && denied) return yes('Akamai Bot Manager', 'Akamai "Access Denied" reference page');

  // Visible captcha widgets on the form. An INVISIBLE reCAPTCHA badge (data-size="invisible", or just the v3/enterprise script) is not a challenge and many fillable forms have it.
  const widget = (re: RegExp) => Array.from(body.matchAll(re)).map((m) => m[0]);
  const recaptchaVisible = widget(/<div[^>]*class="[^"]*g-recaptcha[^"]*"[^>]*>/gi).some((t) => !/data-size\s*=\s*["']invisible["']/i.test(t) && !/data-sitekey\s*=\s*["']["']/.test(t));
  if (recaptchaVisible) return yes('reCAPTCHA', 'a visible reCAPTCHA checkbox is on the form');
  if (/<div[^>]*class="[^"]*h-captcha[^"]*"[^>]*>/i.test(body)) { const t = widget(/<div[^>]*class="[^"]*h-captcha[^"]*"[^>]*>/gi)[0]; if (!/data-size\s*=\s*["']invisible["']/i.test(t)) return yes('hCaptcha', 'an hCaptcha widget is on the form'); }
  if (/<div[^>]*class="[^"]*cf-turnstile[^"]*"[^>]*>/i.test(body)) return yes('Cloudflare Turnstile', 'a Turnstile widget is on the form');

  // Generic denial that names a bot check.
  if (denied && /verify you are (a )?human|are you a robot|unusual traffic|automated (access|requests)|bot (detection|protection)/.test(lower)) return yes('unknown bot check', `HTTP ${st} with a "verify you are human" page`);

  // Redirect from the ATS URL to a company careers page that has no form.
  if (o.ats && o.finalUrl && ATS_HOSTS[o.ats] && !(st >= 300 && st < 400)) {   // a 3xx has no body yet: wait for the page it points to
    let host = ''; try { host = new URL(o.finalUrl).host; } catch { /* ignore */ }
    if (host && !ATS_HOSTS[o.ats].test(host) && !/<form[\s>]/i.test(body)) return yes('company careers page', `redirects off ${o.ats} to ${host}, no application form in that page (a form embedded by script is not something this tool fills)`);
  }
  return NO;
}

/** A vendor label for a prepare run that was stopped by a blocker. Uses what the page and the browser's requests showed; falls back to the blocker's own words. */
export function classifyBlocked(blockerKind: string, detail: string, blockedRequests: string[]): Protection {
  const c = classify({ blockedRequests });
  if (c.protected) return c;
  const d = detail.toLowerCase();
  const v = /recaptcha/.test(d) ? 'reCAPTCHA' : /hcaptcha/.test(d) ? 'hCaptcha' : /turnstile|cloudflare/.test(d) ? 'Cloudflare' : /datadome/.test(d) ? 'DataDome' : /perimeterx|px-/.test(d) ? 'PerimeterX' : /awswaf|aws waf/.test(d) ? 'AWS WAF' : blockerKind === 'captcha' ? 'unknown bot check' : blockerKind === 'login' ? 'login wall' : 'email verification wall';
  return yes(v, detail.slice(0, 200));
}

// ---- robots.txt (only what we need: may we GET this path as our user agent?) ----
export function robotsAllows(robotsTxt: string, path: string, agentName = 'job-radar'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agentName.toLowerCase().includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of use) for (const r of g.rules) {
    if (!r.path) continue;   // "Disallow:" with no path allows everything
    const rx = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (rx.test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}
