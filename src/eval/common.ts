import fs from 'node:fs';
import type { GoldRow } from './metrics.js';
import { evalPaths, type EvalPaths } from './paths.js';

/** Kept for callers that want the default location; the real check uses the data dir's own GOLD_APPROVED. */
export const APPROVAL_FILE = evalPaths().approval;
export function loadGold(p: EvalPaths = evalPaths()): GoldRow[] {
  return fs.readFileSync(p.gold, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** Hard gate: no eval runs until the user has typed "gold approved" (then `touch <data dir>/GOLD_APPROVED`). The synthetic sample needs no approval. */
export function requireApproval(p: EvalPaths = evalPaths()) {
  if (p.isSample) return;
  if (!fs.existsSync(p.approval)) { console.error(`Refusing to run: gold set not approved (${p.approval} missing).`); process.exit(2); }
}
/** Eval and judge read ONLY the frozen snapshots in <dir>/candidates.jsonl, never the live DB. */
export function jobsByKey(keys: string[], p: EvalPaths = evalPaths()) {
  const snaps = new Map<string, any>();
  for (const l of fs.readFileSync(p.candidates, 'utf8').trim().split('\n')) { const r = JSON.parse(l); if (r.snapshot) snaps.set(r.key, r.snapshot); }
  return new Map(keys.map((k) => { const s = snaps.get(k); if (!s) throw new Error(`no frozen snapshot for ${k}`); return [k, s]; }));
}
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
