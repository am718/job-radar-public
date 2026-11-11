import { MIN_BASE_PAY } from './config.js';

export type PayStatus = 'listed' | 'unclear' | 'unlisted';
export type Interval = 'year' | 'hour' | 'month' | 'week' | 'unknown';
/** Pay as exposed by a source API in structured form. noteText = the text the source ships with the number (used to detect OTE etc.). */
export interface PayRaw { min: number | null; max: number | null; interval: Interval; currency: string | null; noteText: string; trustTyped?: boolean }
// trustTyped: the source marks this figure as base salary in a typed field (Ashby compensationType 'Salary'), so OTE/commission wording elsewhere does not demote it.
export interface PayInfo {
  status: PayStatus; min: number | null; max: number | null;      // annual USD base
  source: 'structured' | 'text' | 'none'; reason?: string; display: string;
  ceiling?: number;   // a clearly LABELED OTE / total-compensation maximum (annual USD). Base <= this, so a ceiling under the floor proves base is under the floor.
  raw?: string;   // the raw pay / OTE text found in the posting or API (for the digest), trimmed
}
export type PayFlag = 'meets floor' | 'negotiable' | 'pay unlisted' | 'below floor';

/** OTE / commission / total compensation: such a number is NOT treated as base. */
/** Strictly labeled OTE / total-comp wording (bare "commission" does not count as a label for the ceiling rule). */
export const OTE_LABEL_RE = /\b(?:ote|o\.t\.e\.?|on[- ]target[- ](?:earnings?|compensation|pay)|total (?:target |annual )?(?:compensation|comp|cash|earnings|pay))\b/i;
export const OTE_RE = /\b(?:ote|o\.t\.e\.?|on[- ]target[- ](?:earnings?|compensation|pay|commission)|commissions?|total (?:target |annual )?(?:compensation|comp|cash|earnings|pay))\b/i;
const NOT_PAY_RE = /(raised|funding|revenue|\barr\b|valuation|series [a-e]\b|signing bonus|sign-on|relocation|stipend|reimburs|budget)/i;
const PAY_CTX_RE = /(salary|base|pay\b|pay range|compensation|wage|range|annual|per year|per hour|hourly|\/\s?yr|\/\s?hr)/i;

export const ANNUALIZE: Record<Interval, number> = { year: 1, hour: 2080, month: 12, week: 52, unknown: NaN };
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

export function intervalFrom(s: string | null | undefined): Interval {
  const t = (s ?? '').toLowerCase();
  if (/year|annual/.test(t)) return 'year';
  if (/hour/.test(t)) return 'hour';
  if (/month/.test(t)) return 'month';
  if (/week/.test(t)) return 'week';
  return 'unknown';
}

export function display(p: Pick<PayInfo, 'status' | 'min' | 'max' | 'reason'>): string {
  if (p.status === 'listed') return p.min === p.max ? `${usd(p.min!)} base` : `${usd(p.min!)}-${usd(p.max!)} base`;
  if (p.status === 'unclear') return `unlisted (unclear: ${p.reason ?? 'could not verify base'})`;
  return 'unlisted';
}
const clip = (t: string, n = 320) => t.replace(/\s+/g, ' ').trim().slice(0, n);
const mk = (status: PayStatus, min: number | null, max: number | null, source: PayInfo['source'], reason?: string, raw?: string): PayInfo => ({ status, min, max, source, reason, display: display({ status, min, max, reason }), raw: raw ? clip(raw) : undefined });

interface TextMatch { annualMin: number; annualMax: number; unclear: boolean; hasBase: boolean; win: string; labeled: boolean; hourly: boolean; dollar: boolean }

// one number: optional "$"/"USD", digits (comma grouped or decimal), optional k
const NUM = String.raw`(?:\$\s?|USD\s?)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?`;
const SEP = String.raw`\s*(?:-|–|—|to|and)\s*`;
const RANGE_RE = new RegExp(`${NUM}(?:${SEP}${NUM})?`, 'g');

/** Finds pay-looking numbers/ranges in free text and classifies each as base or unclear. Exported for tests. */
export function parseTextPay(text: string): TextMatch[] {
  const out: TextMatch[] = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const full = m[0];
    const start = m.index!, end = start + full.length;
    const hasDollar = /^(?:\$|USD)/.test(full) || /(?:-|–|—|to|and)\s*(?:\$|USD)/.test(full);
    const grouped = /\d,\d{3}/.test(full), kSuffix = !!(m[2] || m[4]);
    if (!hasDollar && !grouped && !kSuffix) continue;                      // plain small numbers are not pay
    const afterBare = text.slice(end, end + 40);
    if (!hasDollar) {
      // bare numbers ("115,000", "$"-less): need a pay word right before and must not be a count ("85,000+ companies")
      const pre = text.slice(Math.max(0, start - 60), start);
      if (!/(salary|base|pay|compensation|wage|range)/i.test(pre)) continue;
      if (/^\+?\s*(?!annually\b|per\b|a year\b|usd\b|\/|k\b)[a-z]/i.test(afterBare)) continue;
    }
    const after = text.slice(end, end + 40), before = text.slice(Math.max(0, start - 100), start);
    if (/^\s?(million|billion|mm\b|m\b|b\b|bn\b)/i.test(after)) continue;   // $5M etc.
    const windowAll = before + full + text.slice(end, end + 60);
    if (NOT_PAY_RE.test(windowAll)) continue;
    if (!PAY_CTX_RE.test(windowAll) && !OTE_RE.test(windowAll)) continue;
    let a = parseFloat(m[1].replace(/,/g, '')), b = m[3] ? parseFloat(m[3].replace(/,/g, '')) : a;
    const k1 = !!m[2], k2 = !!m[4];
    if (k1) a *= 1000;
    if (k2) b *= 1000;
    if (!k1 && k2 && m[3] && a < 1000) a *= 1000;                           // "$115 - 135k"
    if (!m[3]) b = a;
    const hourly = /^\s*(?:\/\s?h(?:ou)?r|per\s+hour|an\s+hour|hourly|\/\s?hour)/i.test(after) || /\bhourly\b|per hour/i.test(before.slice(-40));
    const yearly = /^\s*(?:\/\s?yr|per\s+year|annually|a\s+year|per\s+annum|\/\s?year)/i.test(after);
    let mult = 1;
    if (hourly && !yearly) mult = ANNUALIZE.hour;
    else if (a < 1000) continue;                                             // small number without hourly marker
    const lo = a * mult, hi = b * mult;
    if (lo > hi || lo < 20_000 || hi > 2_000_000) continue;
    // OTE test window: up to 100 chars before and, after the number, only to the end of its own sentence/line (max 40 chars).
    // Real case: "salary range ... $110,000 - $147,000/year. Total compensation for this position..." must not be demoted by the NEXT sentence.
    const tail = text.slice(end, end + 40), cut = tail.search(/\.\s|\n/);
    const win = text.slice(Math.max(0, start - 100), end + (cut >= 0 ? cut : tail.length));
    out.push({ annualMin: lo, annualMax: hi, unclear: OTE_RE.test(win), hasBase: /\bbase\b/i.test(win), win, labeled: OTE_LABEL_RE.test(win), hourly: hourly && !yearly, dollar: hasDollar });
  }
  return out;
}

export function payFromText(text: string): PayInfo {
  const ms = parseTextPay(text);
  const ok = ms.filter((m) => !m.unclear);
  if (ok.length) { const pick = ok.find((m) => m.hasBase) ?? ok[0]; return mk('listed', pick.annualMin, pick.annualMax, 'text', undefined, pick.win); }
  if (ms.length) {
    const p = mk('unclear', null, null, 'text', 'mentions OTE/commission/total compensation', ms[0].win);
    // ceiling: only clearly labeled OTE/total-comp figures that are annual and in dollars (hourly or unlabeled figures stay unclear)
    const lab = ms.filter((m) => m.labeled && !m.hourly && m.dollar);
    if (lab.length) { p.ceiling = Math.max(...lab.map((m) => m.annualMax)); p.raw = clip(lab[0].win); }
    return p;
  }
  return mk('unlisted', null, null, 'none');
}

/** Structured source pay first (verified fields only), then description text. */
export function resolvePay(job: { payRaw?: PayRaw | null; description: string }): PayInfo {
  const r = job.payRaw;
  if (r && (r.min != null || r.max != null)) {
    const rawS = `API figure ${r.min ?? '?'}-${r.max ?? '?'} ${r.interval}${r.currency ? ' ' + r.currency : ''}; source text: ${r.noteText ?? ''}`;
    if (r.currency && r.currency.toUpperCase() !== 'USD') return mk('unclear', null, null, 'structured', `non-USD (${r.currency})`, rawS);
    if (r.interval === 'unknown') return mk('unclear', null, null, 'structured', 'unknown pay interval', rawS);
    if (!r.trustTyped && OTE_RE.test(r.noteText ?? '')) {
      const p = mk('unclear', null, null, 'structured', 'mentions OTE/commission/total compensation', rawS);
      const hi = (r.max ?? r.min!) * ANNUALIZE[r.interval];
      // clearly labeled OTE/total-comp + annual + USD + plausible amount => the figure is a ceiling on base pay
      if (OTE_LABEL_RE.test(r.noteText ?? '') && r.interval === 'year' && String(r.currency ?? '').toUpperCase() === 'USD' && hi >= 20_000) p.ceiling = hi;
      return p;
    }
    const mult = ANNUALIZE[r.interval];
    const lo = (r.min ?? r.max!) * mult, hi = (r.max ?? r.min!) * mult;
    if (!(lo > 0) || lo > hi) return mk('unclear', null, null, 'structured', 'implausible range', rawS);
    // Real case: a Greenhouse range titled "Annual Base Salary" held $35-$58 (hourly dollars). Never trust a tiny "annual" figure.
    if (r.interval === 'year' && hi < 20_000) return mk('unclear', null, null, 'structured', 'implausibly low annual amount (possibly hourly)', rawS);
    return mk('listed', lo, hi, 'structured', undefined, rawS);
  }
  return payFromText(job.description ?? '');
}

export interface PayDecision { drop: boolean; flag: PayFlag; rankAdj: number; rule?: string }
/** The four rules. Floor is annual base USD. */
export function applyPayRules(p: Pick<PayInfo, 'status' | 'min' | 'max'> & { ceiling?: number }, floor: number = MIN_BASE_PAY): PayDecision {
  if (p.status === 'unclear' && p.ceiling != null && p.ceiling < floor) return { drop: true, flag: 'below floor', rankAdj: 0, rule: `labeled OTE/total-comp max ${usd(p.ceiling)} is below the ${usd(floor)} floor, so base is too` };
  if (p.status !== 'listed' || p.min == null || p.max == null) return { drop: false, flag: 'pay unlisted', rankAdj: PAY_ADJ['pay unlisted'] };
  if (p.max < floor) return { drop: true, flag: 'below floor', rankAdj: 0, rule: `listed base max ${usd(p.max)} is below the ${usd(floor)} floor` };
  if (p.min < floor) return { drop: false, flag: 'negotiable', rankAdj: PAY_ADJ.negotiable };
  return { drop: false, flag: 'meets floor', rankAdj: PAY_ADJ['meets floor'] };
}
/** Rank adjustments (ranking only; the stored LLM score is never changed). Unlisted/unclear ranks below comparable listed-pay jobs. */
export const PAY_ADJ: Record<PayFlag, number> = { 'meets floor': 3, negotiable: 0, 'pay unlisted': -3, 'below floor': 0 };
