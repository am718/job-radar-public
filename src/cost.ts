import { DESCRIPTION_CHAR_LIMIT } from './config.js';
import { PROMPTS } from './scoring/prompts.js';

/** Rough token estimate (chars/4). Dollar figures only if the user supplies per-Mtok prices via env. */
export function estimateCost(descLens: number[], calls = 1) {
  const sys = PROMPTS.v3.system.length;
  const inTok = descLens.reduce((a, l) => a + Math.ceil((Math.min(l, DESCRIPTION_CHAR_LIMIT) + sys + 900) / 4), 0) * calls;
  const outTok = descLens.length * calls * 200;
  const pin = Number(process.env.PRICE_IN_PER_MTOK), pout = Number(process.env.PRICE_OUT_PER_MTOK);
  const usd = pin > 0 && pout > 0 ? (inTok * pin + outTok * pout) / 1e6 : null;
  return { requests: descLens.length * calls, inTok, outTok, usd };
}
export function printEstimate(label: string, e: ReturnType<typeof estimateCost>) {
  console.log(`LLM cost estimate (${label}): ${e.requests} requests, ~${e.inTok} input tokens, ~${e.outTok} output tokens` +
    (e.usd != null ? `, ~$${e.usd.toFixed(2)}` : ' (set PRICE_IN_PER_MTOK / PRICE_OUT_PER_MTOK in env for a $ figure; not guessed here)'));
}
