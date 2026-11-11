import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Browser, Page } from 'playwright';
import type { LlmFn } from '../scoring/scorer.js';
import { loadAnswers, type Answers } from '../apply/answers.js';
import { prepareJob, prepareBatch, type PrepareResult } from '../apply/prepare.js';
import { missingChecks } from '../apply/fill.js';
import { classifyBlocked } from '../apply/protection.js';
import { ACTIVE_STATES, type Launcher, type RunState, type RunStatus } from './launch.js';

// The prepare-run manager behind "Open and fill". It runs the SAME code as `npm run prepare` (prepareJob / prepareBatch with handoff on) and only observes it through
// the optional phase hooks. It never touches a handed-off page except page.bringToFront() (not an action on the page's content).

export interface LauncherOpts {
  db: Database.Database; preparedDir: string; answersFile?: string; headless?: boolean; urlFor?: (key: string) => string; llm?: LlmFn | null; noLetter?: boolean; noNote?: boolean;
  prepare?: { job?: typeof prepareJob; batch?: typeof prepareBatch };   // injected by tests
}
interface Rec { st: RunStatus; page: Page | null }
const first = (s: string) => String(s ?? '').split('\n')[0].trim().slice(0, 300);

export function createLauncher(o: LauncherOpts): Launcher {
  const runs = new Map<string, Rec>();
  const browsers = new Set<Browser>();
  const doJob = o.prepare?.job ?? prepareJob, doBatch = o.prepare?.batch ?? prepareBatch;
  const now = () => new Date().toISOString();
  const set = (key: string, p: Partial<RunStatus>) => { const r = runs.get(key); if (r) Object.assign(r.st, p, { updatedAt: now() }); };

  function finish(key: string, r: PrepareResult | { key: string; error: string }): void {
    const rec = runs.get(key); if (!rec) return;
    if ('error' in r) { set(key, { state: 'failed', reason: first(r.error), detail: undefined, fields: undefined }); return; }
    try { const b = r.page?.context().browser(); if (b) browsers.add(b); } catch { /* ignore */ }
    if (r.page) {
      rec.page = r.page; rec.st.windowOpen = true;
      const gone = () => { if (rec.page === r.page) { rec.page = null; set(key, { windowOpen: false }); } };
      void Promise.resolve(r.closed).then(gone, gone);
    }
    const hasShot = !!r.screenshot && fs.existsSync(r.screenshot);
    const base: Partial<RunStatus> = { hasShot, company: r.company || rec.st.company, title: r.title || rec.st.title, fields: undefined, reason: undefined, detail: undefined };
    if (r.blocker) {
      let vendor = ''; try { const c = classifyBlocked(r.blocker.kind, r.blocker.detail, r.blockedRequests ?? []); if (c.protected && c.vendor) vendor = ` [${c.vendor}]`; } catch { /* ignore */ }
      set(key, { ...base, state: 'blocked', reason: `${r.blocker.kind}: ${first(r.blocker.detail)}${vendor}` }); return;
    }
    if (!r.report) { set(key, { ...base, state: 'failed', reason: 'the form was not filled' }); return; }
    if (r.complete && r.handedOff) { set(key, { ...base, state: 'complete', detail: 'FILL COMPLETE - review and submit' }); return; }
    const rep = r.report, seen = new Set<string>(), fields: string[] = [];
    const add = (f: string) => { if (f && !seen.has(f)) { seen.add(f); fields.push(f); } };
    for (const m of missingChecks(rep)) add(m.item);
    for (const b of rep.blank) if (b.required) add(b.field);
    for (const u of rep.uncertain) add(u.field);
    for (const u of rep.unregistered ?? []) add(u.field);
    set(key, { ...base, state: 'needs_you', fields, detail: r.complete ? 'filled, but not handed off' : 'NEEDS YOU' });
  }

  async function run(keys: string[]): Promise<void> {
    try {
      let answers: Answers;
      try { answers = loadAnswers(o.answersFile ?? 'answers.json'); }
      catch (e) { for (const k of keys) set(k, { state: 'failed', reason: first((e as Error).message) }); return; }
      let llm: LlmFn | null = null, llmWhy: string | undefined;
      if (o.llm !== undefined) llm = o.llm;
      else if (!o.noNote || !o.noLetter) {
        try { const { budgetedLlm } = await import('../spend.js'); llm = budgetedLlm('APPLY', 'apply note+letter', { maxTokens: 2500, noThinking: true }); }
        catch (e) { llmWhy = (e as Error).message; }
      }
      const log = () => {};   // dashboard runs are silent; the state is shown in the page
      const phase = (key: string, p: 'opening' | 'filling' | 'verifying', d?: string) => set(key, { state: p, detail: d });
      if (keys.length === 1) {
        const key = keys[0];
        try { finish(key, await doJob({ db: o.db, id: key, answers, llm, llmWhy, handoff: true, headless: o.headless, preparedDir: o.preparedDir, urlOverride: o.urlFor?.(key), log, noLetter: o.noLetter, noNote: o.noNote, onPhase: (p, d) => phase(key, p, d) })); }
        catch (e) { finish(key, { key, error: (e as Error).message }); }
      } else {
        try { await doBatch({ db: o.db, ids: keys, answers, llm, llmWhy, handoff: true, parallel: 3, headless: o.headless, preparedDir: o.preparedDir, urlFor: o.urlFor, log, noLetter: o.noLetter, noNote: o.noNote, onPhase: phase, onResult: (r) => finish(r.key, r) }); }
        catch (e) { for (const k of keys) if (ACTIVE_STATES.includes(runs.get(k)?.st.state as RunState)) set(k, { state: 'failed', reason: first((e as Error).message) }); }
      }
    } catch (e) {
      for (const k of keys) if (ACTIVE_STATES.includes(runs.get(k)?.st.state as RunState)) set(k, { state: 'failed', reason: first((e as Error).message) });
    }
  }

  const appliedInfo = (key: string): { via: 'auto' | 'manual' } | null => {
    try {
      const j = o.db.prepare('SELECT status FROM jobs WHERE key=?').get(key) as { status: string } | undefined;
      if (j?.status !== 'applied') return null;
      let via: unknown = null; try { via = (o.db.prepare("SELECT via FROM mark_log WHERE key=? AND status='applied' ORDER BY at DESC, rowid DESC LIMIT 1").get(key) as { via: string | null } | undefined)?.via; } catch { /* old schema */ }
      return { via: via === 'auto' ? 'auto' : 'manual' };
    } catch { return null; }
  };

  return {
    isBusy: (key) => { const r = runs.get(key); return !!r && (ACTIVE_STATES.includes(r.st.state) || r.st.windowOpen); },
    start(keys) {
      for (const key of keys) {
        const j = (() => { try { return o.db.prepare('SELECT company, title FROM jobs WHERE key=?').get(key) as { company: string; title: string } | undefined; } catch { return undefined; } })();
        const t = now();
        runs.set(key, { page: null, st: { key, state: 'queued', company: j?.company, title: j?.title, hasShot: false, windowOpen: false, startedAt: t, updatedAt: t } });
      }
      setImmediate(() => { void run([...keys]); });   // the caller sees "queued" first and start() returns at once
    },
    list() {
      return [...runs.values()].map(({ st }) => {
        const a = appliedInfo(st.key);
        const out: RunStatus = { ...st, fields: st.fields ? [...st.fields] : undefined };
        return a ? { ...out, state: 'applied' as const, via: a.via, detail: undefined, reason: undefined, fields: undefined } : out;
      });
    },
    async focus(key) {
      const p = runs.get(key)?.page;
      if (!p || p.isClosed()) return false;
      try { await p.bringToFront(); return true; } catch { return false; }
    },
    async close() { for (const b of browsers) await b.close().catch(() => {}); browsers.clear(); },
  };
}
