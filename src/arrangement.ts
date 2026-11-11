export type Arrangement = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export interface ArrangementInfo { arrangement: Arrangement; officeDays: number | null; source: 'structured' | 'location' | 'text' | 'none'; evidence: string }

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const num = (s: string) => (/^\d$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);
const N = String.raw`(\d|one|two|three|four|five)`;
const OFFICE = String.raw`(?:in[- ]the[- ]office|in[- ]office|on[- ]?site|in[- ]person|at (?:our|the) office|in (?:our|the) (?:\w+ )?office)`;
const DAYS_BEFORE = new RegExp(String.raw`\b${N}\s*(?:\+\s*)?days?\s*(?:per|a|each|/)?\s*(?:week)?\s*(?:,?\s*(?:are|is)?\s*)?(?:in|at|on)?[- ]?${OFFICE}`, 'i');
const DAYS_AFTER = new RegExp(String.raw`${OFFICE}[^.\n]{0,25}?\b${N}\s*days?\b`, 'i');
const HYBRID_DAYS = new RegExp(String.raw`\bhybrid\b[^.\n]{0,40}?\b${N}\s*days?\b`, 'i');
const HYBRID = /\bhybrid\s+(?:work|working|model|schedule|role|position|arrangement|environment|office|setup|policy|in[- ]office)\b|\b(?:is|are|as|be|a)\s+(?:a\s+)?hybrid\b|\bhybrid\s*(?:[-–:(]|\|)/i;
const REMOTE = /\b(?:fully|100%|completely)\s+remote\b|\bremote[- ]first\b|\b(?:this|the)\s+(?:role|position|job)\s+is\s+(?:fully\s+)?remote\b|\bremote\s+(?:position|role|job|opportunity)\b|\bwork\s+(?:from\s+)?(?:anywhere|home)\b|\bremote\s+within\s+the\s+(?:us|u\.s\.|united states)/i;
const ONSITE = /\b(?:this|the)\s+(?:role|position|job)\s+is\s+(?:fully\s+|100%\s+)?(?:on[- ]?site|in[- ]office|in[- ]person)\b|\bfully\s+(?:on[- ]?site|in[- ]office)\b|\bmust\s+(?:be\s+)?(?:work\s+)?(?:on[- ]?site|in[- ]office)\b|\bin[- ]office\s+(?:full[- ]time|five days)/i;
const NEG_REMOTE = /\b(?:not|no|isn'?t|non)[- ]\s*(?:a\s+)?(?:fully\s+)?remote\b/i;

const snippet = (t: string, i: number, len: number) => t.slice(Math.max(0, i - 40), i + len + 40).replace(/\s+/g, ' ').trim();
const map = (v: string): Arrangement | null => {
  const t = v.toLowerCase().replace(/[^a-z]/g, '');
  if (t.startsWith('remote')) return 'remote';
  if (t.startsWith('hybrid')) return 'hybrid';
  if (t.startsWith('onsite') || t === 'inoffice') return 'onsite';
  return null;
};

/** Text-only detection (description + location string). Never guesses: returns unknown when no explicit phrase matches. */
export function detectFromText(description: string, location = ''): ArrangementInfo {
  const loc = location.trim();
  if (/^\s*(?:fully\s+)?remote\b(?![- ]?friendly)/i.test(loc)) return { arrangement: 'remote', officeDays: null, source: 'location', evidence: loc };
  if (/\bhybrid\b/i.test(loc)) {
    const m = HYBRID_DAYS.exec(loc);
    return { arrangement: 'hybrid', officeDays: m ? num(m[1]) : null, source: 'location', evidence: loc };
  }
  const t = description ?? '';
  // office days stated ("3 days in office", "in office 3 days", "hybrid, 3 days")
  for (const re of [DAYS_BEFORE, DAYS_AFTER, HYBRID_DAYS]) {
    const m = re.exec(t);
    if (m) {
      const d = num(m[1]);
      if (d >= 1 && d <= 5) return d >= 5 ? { arrangement: 'onsite', officeDays: 5, source: 'text', evidence: snippet(t, m.index, m[0].length) } : { arrangement: 'hybrid', officeDays: d, source: 'text', evidence: snippet(t, m.index, m[0].length) };
    }
  }
  let m = HYBRID.exec(t);
  if (m) return { arrangement: 'hybrid', officeDays: null, source: 'text', evidence: snippet(t, m.index, m[0].length) };
  m = ONSITE.exec(t);
  if (m) return { arrangement: 'onsite', officeDays: null, source: 'text', evidence: snippet(t, m.index, m[0].length) };
  m = REMOTE.exec(t);
  if (m && !NEG_REMOTE.test(t)) return { arrangement: 'remote', officeDays: null, source: 'text', evidence: snippet(t, m.index, m[0].length) };
  return { arrangement: 'unknown', officeDays: null, source: 'none', evidence: '' };
}

/** Structured source field first (workplaceRaw: Ashby/Lever workplaceType, Greenhouse custom "Workplace Type"/"Location Type"), then text. Office days only from text. */
export function detectArrangement(job: { workplaceRaw?: string | null; description: string; location?: string }): ArrangementInfo {
  const text = detectFromText(job.description, job.location ?? '');
  const s = job.workplaceRaw ? map(job.workplaceRaw) : null;
  if (s) {
    const days = s === 'hybrid' && text.arrangement === 'hybrid' ? text.officeDays : null;
    return { arrangement: s, officeDays: days, source: 'structured', evidence: `workplace field: ${job.workplaceRaw}` };
  }
  return text;
}

/** High-demand-hours heuristic. A note only: never used to drop or re-rank. */
export const HOURS_TERMS: [string, RegExp][] = [
  ['on-call', /\bon[- ]call\b/i], ['travel up to', /\btravel(?:ing)?\s+up\s+to\b/i], ['frequent travel', /\bfrequent(?:ly)?\s+travel/i],
  ['client site', /\bclient[- ]sites?\b|\bon[- ]site with clients\b/i], ['weekends', /\bweekends?\b/i], ['fast-paced startup', /\bfast[- ]paced\s+(?:start[- ]?up|environment)\b/i], ['24/7', /\b24\s*\/\s*7\b/],
];
/** Shift terms in the job TITLE (e.g. "Support Engineer I (NYC, Weekend Shift)"). Flagged as a note only, like the description terms. */
export const TITLE_HOURS_TERMS: [string, RegExp][] = [
  ['weekend shift (title)', /\bweekends?\b/i], ['night shift (title)', /\bnights?\b/i], ['overnight (title)', /\bovernight\b|\bgraveyard\b/i],
  ['on-call (title)', /\bon[- ]?call\b/i], ['rotating shift (title)', /\brotating\b|\brotational\b|\bswing\s+shift\b/i], ['evening shift (title)', /\bevenings?\b/i],
];
export function hoursNote(description: string, title = ''): string[] {
  return [...HOURS_TERMS.filter(([, re]) => re.test(description ?? '')).map(([name]) => name), ...TITLE_HOURS_TERMS.filter(([, re]) => re.test(title ?? '')).map(([name]) => name)];
}

/** Rank adjustment (<= 0). Steps (5) exceed the largest tier-bonus spread (4), so at equal fit, pay status and tier:
 * remote > hybrid (<=3 office days, or days unstated) > unknown > hybrid 4 days > onsite (or hybrid 5 days). Onsite is a penalty, never a drop. */
export function arrangementAdj(a: Arrangement, officeDays: number | null): number {
  if (a === 'remote') return 0;
  if (a === 'hybrid') return officeDays == null || officeDays <= 3 ? -5 : officeDays === 4 ? -10 : -15;
  if (a === 'onsite') return -15;
  return -8;
}
export const isLowOffice = (a: Arrangement, officeDays: number | null) => a === 'remote' || (a === 'hybrid' && officeDays != null && officeDays <= 3);
export const arrangementLabel = (a: Arrangement, d: number | null) => (a === 'hybrid' ? `hybrid${d != null ? `, ${d} office day${d === 1 ? '' : 's'}/week` : ', office days not stated'}` : a === 'onsite' ? `onsite${d != null ? `, ${d} days/week` : ''}` : a);
