import type Database from 'better-sqlite3';
import { cacheVersion } from '../scoring/scorer.js';
import { isFillable } from '../types.js';
import { KEY_RE } from './security.js';

// The contract between the dashboard server and the code that runs prepares (src/dashboard/runs.ts).
// The SERVER validates everything (this file); the launcher only ever receives keys that passed validateLaunch().

/** queued -> opening -> filling -> verifying -> complete | needs_you | blocked | failed; any of them -> applied when the job is marked applied. */
export type RunState = 'queued' | 'opening' | 'filling' | 'verifying' | 'complete' | 'needs_you' | 'blocked' | 'failed' | 'applied';
export const ACTIVE_STATES: readonly RunState[] = ['queued', 'opening', 'filling', 'verifying'];

export interface RunStatus {
  key: string; state: RunState;
  company?: string; title?: string;
  detail?: string;          // one line for the UI (e.g. "FILL COMPLETE - review and submit")
  fields?: string[];        // needs_you: the blank / uncertain / missing fields, by label
  reason?: string;          // blocked / failed: why
  via?: 'auto' | 'manual';  // applied: who marked it
  hasShot: boolean;         // a screenshot of the filled form exists (GET /shot?key=)
  windowOpen: boolean;      // the prepared tab is still open (Focus window possible)
  startedAt: string; updatedAt: string;
}

export interface Launcher {
  /** true while a run for this key is queued/working, or its prepared window is still open. A second launch is refused while true. */
  isBusy(key: string): boolean;
  /** Starts ONE prepare run per key (a batch when several): same code path as `npm run prepare`. Never awaits the browser. */
  start(keys: string[], o: { allowLowFit: boolean }): void;
  list(): RunStatus[];
  /** Brings the prepared tab's window to the front (page.bringToFront: not an action on the page's content). false if no open window. */
  focus(key: string): Promise<boolean>;
  close(): Promise<void>;
}

export const MAX_BATCH = 10;

export type LaunchCheck = { ok: true; keys: string[] } | { ok: false; code: number; error: string; keys?: string[] };

/** Validates a launch request against the database. Nothing from the request is used except job keys, and only after they are found in the DB. */
export function validateLaunch(db: Database.Database, body: unknown, launcher: Launcher, rules: { minScore: number; remainingToday: number; preparedToday: (key: string) => boolean }): LaunchCheck {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 400, error: 'need {keys: [...]}' };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== 'keys' && k !== 'allowLowFit');
  if (extra.length) return { ok: false, code: 400, error: `unexpected field(s): ${extra.join(', ')}` };   // no url / path / command / option is ever taken from a request
  if (b.allowLowFit !== undefined && typeof b.allowLowFit !== 'boolean') return { ok: false, code: 400, error: 'allowLowFit must be true or false' };
  const keys = b.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_BATCH) return { ok: false, code: 400, error: `keys must be a list of 1-${MAX_BATCH} job keys` };
  if (keys.some((k) => typeof k !== 'string' || !KEY_RE.test(k))) return { ok: false, code: 400, error: 'bad job key' };
  const uniq = [...new Set(keys as string[])];
  const cv = cacheVersion('v3');
  const rows = uniq.map((k) => db.prepare('SELECT j.key, j.source, j.status, j.filter_reason, s.json sj FROM jobs j LEFT JOIN scores s ON s.key=j.key AND s.prompt_version=? WHERE j.key=?').get(cv, k) as { key: string; source: string; status: string; filter_reason: string | null; sj: string | null } | undefined);
  const unknown = uniq.filter((_, i) => !rows[i]);
  if (unknown.length) return { ok: false, code: 404, error: 'no such job', keys: unknown };
  const notFillable = rows.filter((r) => !isFillable(r!.source)).map((r) => r!.key);
  if (notFillable.length) return { ok: false, code: 422, error: 'this site cannot be filled by the tool: apply by hand (use Copy sheet)', keys: notFillable };
  const done = rows.filter((r) => r!.status === 'applied' || r!.status === 'skip').map((r) => r!.key);
  if (done.length) return { ok: false, code: 409, error: 'already marked applied or skipped', keys: done };
  const busy = uniq.filter((k) => launcher.isBusy(k));
  if (busy.length) return { ok: false, code: 409, error: 'already running or its window is still open', keys: busy };
  const low = rows.filter((r) => { try { return (JSON.parse(r!.sj ?? 'null')?.score ?? -1) < rules.minScore; } catch { return true; } }).map((r) => r!.key);
  if (low.length && b.allowLowFit !== true) return { ok: false, code: 422, error: `fit below ${rules.minScore}: confirm to open anyway`, keys: low };
  const newToday = uniq.filter((k) => !rules.preparedToday(k)).length;   // re-opening a job already prepared today does not use the cap again
  if (newToday > rules.remainingToday) return { ok: false, code: 429, error: `daily cap: ${rules.remainingToday} more prepare(s) allowed today` };
  return { ok: true, keys: uniq };
}
