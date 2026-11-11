// Cross-source de-duplication: conservative normalization + source priority.
// False merges are worse than missed ones, so every rule here errs towards "different".

const FILLABLE_SRC = new Set(['greenhouse', 'lever', 'ashby']);
const BOARD_SRC = new Set(['workable', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'personio', 'teamtailor', 'workday']);
const FEED_SRC = new Set(['hn', 'remoteok', 'wwr', 'usajobs', 'adzuna']);

/** 3 = fillable ATS, 2 = other board ATS, 1 = feed, 0 = alert/link/unknown. The highest priority is the primary row. */
export const sourcePriority = (source: string): number =>
  FILLABLE_SRC.has(source) ? 3 : BOARD_SRC.has(source) ? 2 : FEED_SRC.has(source) ? 1 : 0;

export const DEDUP_WINDOW_MS = 30 * 24 * 3600 * 1000;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
/** lower-case, '&' -> 'and', drop apostrophes/dots inside words, every other punctuation -> space, collapse spaces. */
const base = (s: string) =>
  collapse((s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/['’`.]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' '));

const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'gmbh', 'plc']);

export function normCompany(s: string): string {
  let w = base(s).split(' ').filter(Boolean);
  if (w.length > 1 && w[0] === 'the') w = w.slice(1);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}

export function normTitle(s: string): string {
  let t = (s ?? '').trim();
  // trailing requisition ids: "(R12345)", "[REQ-1234]", "- 12345", "- R-12345", "#12345"
  const bracketId = /\s*[([]\s*(?:req|requisition|job|id|r)?\s*[-#_:]?\s*[a-z]{0,3}\d{3,}[a-z0-9-]*\s*[)\]]\s*$/i;
  const dashId = /\s*(?:[-–—|]|#)\s*(?:req|requisition|job|id|r)?\s*[-#_:]?\s*[a-z]{0,3}\d{3,}[a-z0-9-]*\s*$/i;
  for (let i = 0; i < 2; i++) t = t.replace(bracketId, '').replace(dashId, '');
  t = t.replace(/\bsr\.?(?=\s|$)/gi, 'senior');
  return base(t);
}

const US_WORDS = new Set(['us', 'usa', 'u', 's', 'united', 'states', 'america', 'of']);
const NYC = new Set(['new york', 'new york city', 'nyc', 'ny', 'new york ny', 'manhattan', 'brooklyn']);

export function normLocation(s: string): string {
  const full = base(s);
  if (!full) return '';
  const words = full.split(' ');
  if (words.includes('remote')) {
    const rest = words.filter((w) => w !== 'remote' && !US_WORDS.has(w));
    return rest.length === 0 ? 'remote' : full;   // "Remote - Canada", "Remote, New York" stay distinct
  }
  // first comma/slash/pipe/semicolon segment, parenthetical removed
  const seg = collapse(base((s ?? '').replace(/\([^)]*\)/g, ' ').split(/[,;/|]/)[0] ?? ''));
  const city = seg || full;
  return NYC.has(city) ? 'new york' : city;
}

/** company|title|location, normalized. Empty when any part is empty (such a row must never be matched). */
export function dedupNorm(j: { company: string; title: string; location: string }): string {
  const c = normCompany(j.company), t = normTitle(j.title), l = normLocation(j.location);
  return c && t && l ? `${c}|${t}|${l}` : '';
}
