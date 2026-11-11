/** Hosts the tool must NEVER request (terms of service). Subdomains and ccTLD variants included. */
const FORBIDDEN_RE = [
  /(^|\.)(linkedin|indeed|glassdoor)\.[a-z]{2,}(\.[a-z]{2})?$/,
  /(^|\.)(joinhandshake\.com|lnkd\.in|licdn\.com|indeedemail\.com)$/,
];
export const normHost = (h: string) => h.toLowerCase().replace(/\.$/, '');
export const isForbiddenHost = (host: string): boolean => { const h = normHost(host); return FORBIDDEN_RE.some((r) => r.test(h)); };

/** IP literals (any form URL normalizes to dotted decimal or [v6]), localhost, *.local and other non-public names are refused outright. */
export function isUnsafeHost(host: string): boolean {
  const h = normHost(host);
  if (!h || h.startsWith('[') || h.includes(':')) return true;
  if (/^\d+(\.\d+){0,3}$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa|localdomain|corp)$/.test(h)) return true;
  return !h.includes('.');
}

export const FORBIDDEN_MESSAGE = "LinkedIn/Indeed/Handshake pages can't be fetched (their terms forbid it); paste the company's own apply link, or use ingest:email";

/** null when the URL may be requested, else a human reason. */
export function urlRefusal(raw: string): { kind: 'forbidden' | 'unsafe' | 'invalid'; reason: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return { kind: 'invalid', reason: 'not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'invalid', reason: 'only http(s) URLs are accepted' };
  if (isForbiddenHost(u.hostname)) return { kind: 'forbidden', reason: FORBIDDEN_MESSAGE };
  if (isUnsafeHost(u.hostname)) return { kind: 'unsafe', reason: 'refusing IP-literal, localhost or private hosts' };
  return null;
}
