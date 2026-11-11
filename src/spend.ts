import fs from 'node:fs';
import path from 'node:path';
import { anthropicLlm, type LlmFn, type LlmOpts } from './scoring/scorer.js';

/** Scan (FEED) spending is capped per calendar month (America/New_York), resetting on the 1st. Other phases keep their lifetime caps. */
export const MONTHLY_CAP_USD = 20;
export const WARN_FRACTION = 0.8;   // warn when within 20% of the cap
export const monthOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7);
// Hard spend caps. Ledger lives in data/spend.json (gitignored). Phase A cap $2, Phase B cap $15.
const FILE = process.env.SPEND_FILE ?? 'data/spend.json';
interface Ledger { phases: Record<string, { cap_usd: number; spent_usd: number; monthly?: boolean }>; log: { ts: string; phase: string; label: string; usd: number }[] }
const DEFAULT: Ledger = { phases: { A: { cap_usd: 2, spent_usd: 0.1125 /* earlier real 3-company scan */ }, B: { cap_usd: 15, spent_usd: 0 }, FEED: { cap_usd: MONTHLY_CAP_USD, spent_usd: 0, monthly: true }, PROXY: { cap_usd: 1, spent_usd: 0 }, PROXY2: { cap_usd: 2, spent_usd: 0 }, APPLY: { cap_usd: 1, spent_usd: 0 } }, log: [] };
const price = () => ({ pin: Number(process.env.PRICE_IN_PER_MTOK), pout: Number(process.env.PRICE_OUT_PER_MTOK) });
export const costOf = (inTok: number, outTok: number) => { const { pin, pout } = price(); if (!(pin > 0 && pout > 0)) throw new Error('PRICE_* env missing'); return (inTok * pin + outTok * pout) / 1e6; };

export function loadLedger(): Ledger {
  if (!fs.existsSync(FILE)) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(DEFAULT, null, 1)); }
  const l: Ledger = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const [k, v] of Object.entries(DEFAULT.phases)) if (!l.phases[k]) l.phases[k] = { ...v };
  if (l.phases.FEED && !l.phases.FEED.monthly) l.phases.FEED = { ...l.phases.FEED, cap_usd: MONTHLY_CAP_USD, monthly: true };   // migrate the old lifetime $6 FEED cap
  return l;
}
const save = (l: Ledger) => fs.writeFileSync(FILE, JSON.stringify(l, null, 1));
export function charge(phase: string, label: string, usd: number) {
  const l = loadLedger(); l.phases[phase].spent_usd += usd; l.log.push({ ts: new Date().toISOString(), phase, label, usd }); save(l);
}
/** Spend counted against the phase cap: this calendar month for monthly phases (summed from the log), else lifetime. */
export function spentFor(l: Ledger, phase: string, now = new Date()): number {
  const p = l.phases[phase];
  if (!p.monthly) return p.spent_usd;
  const m = monthOf(now.toISOString());
  return l.log.filter((e) => e.phase === phase && monthOf(e.ts) === m).reduce((a, e) => a + e.usd, 0);
}
export function summary(phase: string, now = new Date()) {
  const l = loadLedger(), p = l.phases[phase], sp = spentFor(l, phase, now);
  return `spend phase ${phase}${p.monthly ? ` (${monthOf(now.toISOString())}, resets on the 1st)` : ''}: $${sp.toFixed(4)} of $${p.cap_usd.toFixed(2)} ${p.monthly ? 'monthly ' : ''}cap ($${(p.cap_usd - sp).toFixed(4)} left)`;
}
/** A loud warning line when spend is within 20% of the cap (or past it); null otherwise. */
export function capWarning(phase: string, now = new Date()): string | null {
  const l = loadLedger(), p = l.phases[phase], sp = spentFor(l, phase, now);
  if (sp >= p.cap_usd) return `!! SPEND CAP REACHED: ${summary(phase, now)}. No further LLM calls will be made${p.monthly ? ' until the 1st' : ''}.`;
  if (sp >= WARN_FRACTION * p.cap_usd) return `!! WARNING: within 20% of the ${p.monthly ? 'monthly ' : ''}spend cap: ${summary(phase, now)}`;
  return null;
}
export class BudgetError extends Error {}

/** Anthropic LLM that charges the ledger per call and refuses any call whose worst-case cost would pass the cap. */
export function budgetedLlm(phase: string, label: string, opts: LlmOpts = {}): LlmFn {
  let warned = false;
  const inner = anthropicLlm((i, o) => charge(phase, label, costOf(i, o)), opts);
  return async (system, user) => {
    const l = loadLedger(), p = l.phases[phase];
    const worst = costOf(Math.ceil((system.length + user.length) / 3), opts.maxTokens ?? 1500);
    if (!warned) { const w = capWarning(phase); if (w) { console.warn(w); warned = true; } }
    if (spentFor(l, phase) + worst > p.cap_usd) throw new BudgetError(`budget cap reached for phase ${phase}: ${summary(phase)}`);
    return inner(system, user);
  };
}
