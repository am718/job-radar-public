import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertJob } from '../src/store.js';
import { AnswersSchema } from '../src/apply/answers.js';
import { markJob } from '../src/marking.js';
import { createLauncher } from '../src/dashboard/runs.js';
import type { Launcher } from '../src/dashboard/launch.js';

// Unit tests for the run manager with an INJECTED fake prepare: no browser, no network, temp files only.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
const answersFile = path.join(tmp, 'answers.json');
fs.writeFileSync(answersFile, JSON.stringify(AnswersSchema.parse({ name: 'T P', first_name: 'T', last_name: 'P', email: 't@example.com', phone: '555-0100', city: 'X', state: 'NY', country: 'US' })));
const shot = path.join(tmp, 'form.png'); fs.writeFileSync(shot, 'png');

const mkdb = (n = 3) => { const db = openDb(':memory:'); for (let i = 1; i <= n; i++) upsertJob(db, { source: 'lever', id: String(i), company: `Co${i}`, title: `Eng ${i}`, location: 'NYC', description: 'x', url: `https://example.test/lever/${i}` }, 1, null); return db; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await tick(); expect(f()).toBe(true); };
const state = (l: Launcher, key: string) => l.list().find((r) => r.key === key)!;
const check = (item: string, status: string) => ({ item, status, detail: `${item} ${status}` });
const report = (o: any = {}) => ({ filled: [], blank: [], checks: [check('name', 'filled'), check('email', 'filled'), check('phone', 'filled'), check('resume', 'filled'), check('cover letter', 'filled')], uncertain: [], reapplied: [], notePlacedInForm: false, letterStatus: 'attached', ...o });
const result = (key: string, o: any = {}) => ({ key, url: 'u', track: 'A', blocker: null, report: report(), notePath: null, noteCached: null, blockedSubmits: 0, blockedRequests: [], closed: new Promise<void>(() => {}), summary: '', letterPdf: null, letterMd: null, page: { isClosed: () => false, bringToFront: async () => {} }, company: 'C', title: 'T', complete: true, screenshot: shot, handedOff: true, ...o });

describe('createLauncher (fake prepare)', () => {
  it('one prepare call per key; states go queued -> opening -> filling -> verifying -> complete in order; busy while the window is open', async () => {
    let calls = 0; const seen: string[] = []; let closeWin!: () => void; let launcher!: Launcher;
    const closed = new Promise<void>((r) => { closeWin = r; });
    const job: any = async (o: any) => { calls++; seen.push(state(launcher, o.id).state); for (const p of ['opening', 'filling', 'verifying'] as const) { o.onPhase(p); seen.push(state(launcher, o.id).state); await tick(); } expect(o.handoff).toBe(true); return result(o.id, { closed }); };
    launcher = createLauncher({ db: mkdb(), preparedDir: tmp, answersFile, llm: null, prepare: { job } });
    launcher.start(['lever:1'], { allowLowFit: false });
    expect(state(launcher, 'lever:1').state).toBe('queued'); expect(launcher.isBusy('lever:1')).toBe(true);
    await until(() => state(launcher, 'lever:1').state === 'complete');
    expect(calls).toBe(1); expect(seen).toEqual(['queued', 'opening', 'filling', 'verifying']);
    const s = state(launcher, 'lever:1');
    expect(s).toMatchObject({ detail: 'FILL COMPLETE - review and submit', hasShot: true, windowOpen: true, company: 'C' });
    expect(launcher.isBusy('lever:1')).toBe(true);          // finished, but the window is still open
    expect(await launcher.focus('lever:1')).toBe(true);
    closeWin(); await until(() => !state(launcher, 'lever:1').windowOpen);
    expect(launcher.isBusy('lever:1')).toBe(false); expect(await launcher.focus('lever:1')).toBe(false);
  });

  it('several keys use ONE batch call (parallel 3) and each result lands as its onResult arrives', async () => {
    let jobCalls = 0, batchCalls = 0; let launcher!: Launcher;
    const batch: any = async (o: any) => { batchCalls++; expect(o.parallel).toBe(3); expect(o.handoff).toBe(true); o.onPhase('lever:1', 'opening'); expect(state(launcher, 'lever:1').state).toBe('opening'); expect(state(launcher, 'lever:2').state).toBe('queued'); o.onResult(result('lever:1')); o.onResult({ key: 'lever:2', error: 'boom\nstack line' }); return { results: [] }; };
    launcher = createLauncher({ db: mkdb(), preparedDir: tmp, answersFile, llm: null, prepare: { job: (async () => { jobCalls++; }) as any, batch } });
    launcher.start(['lever:1', 'lever:2'], { allowLowFit: false });
    await until(() => state(launcher, 'lever:2').state === 'failed');
    expect(batchCalls).toBe(1); expect(jobCalls).toBe(0);
    expect(state(launcher, 'lever:1').state).toBe('complete'); expect(state(launcher, 'lever:2').reason).toBe('boom');
  });

  it('needs_you lists missing essentials first, then required blanks, then uncertain and unregistered fields', async () => {
    const rep = report({ checks: [check('name', 'filled'), check('email', 'filled'), check('phone', 'MISSING'), check('resume', 'MISSING'), check('cover letter', 'filled')], blank: [{ field: 'Why us?', reason: 'x', cause: 'custom', required: true }, { field: 'Pronouns', reason: 'x', cause: 'empty' }], uncertain: [{ field: 'Salary', why: '?' }], unregistered: [{ field: 'Website', why: 'not accepted' }] });
    const launcher = createLauncher({ db: mkdb(), preparedDir: tmp, answersFile, llm: null, prepare: { job: (async (o: any) => result(o.id, { report: rep, complete: false, handedOff: false })) as any } });
    launcher.start(['lever:1'], { allowLowFit: false });
    await until(() => state(launcher, 'lever:1').state === 'needs_you');
    expect(state(launcher, 'lever:1').fields).toEqual(['phone', 'resume', 'Why us?', 'Salary', 'Website']);
  });

  it('blocked carries the blocker kind, detail and the protection vendor; failed carries the first line of the error; both end busy-free', async () => {
    const blocker = { kind: 'captcha', detail: 'a reCAPTCHA challenge is showing' };
    const job: any = async (o: any) => { if (o.id === 'lever:2') throw new Error('net::ERR_FAILED\nmore'); return result(o.id, { blocker, report: null, complete: false, handedOff: false, screenshot: null, closed: Promise.resolve() }); };
    const launcher = createLauncher({ db: mkdb(), preparedDir: tmp, answersFile, llm: null, prepare: { job } });
    launcher.start(['lever:1'], { allowLowFit: false }); launcher.start(['lever:2'], { allowLowFit: false });
    await until(() => state(launcher, 'lever:1').state === 'blocked' && state(launcher, 'lever:2').state === 'failed');
    expect(state(launcher, 'lever:1').reason).toMatch(/^captcha: a reCAPTCHA challenge is showing/); expect(state(launcher, 'lever:1').reason).toMatch(/reCAPTCHA\]$/);
    expect(state(launcher, 'lever:1').hasShot).toBe(false);
    expect(state(launcher, 'lever:2').reason).toBe('net::ERR_FAILED');
    await until(() => !launcher.isBusy('lever:1')); expect(launcher.isBusy('lever:2')).toBe(false);
  });

  it('answers that cannot load fail every key with that message and prepare is never called', async () => {
    let calls = 0;
    const launcher = createLauncher({ db: mkdb(), preparedDir: tmp, answersFile: path.join(tmp, 'nope.json'), llm: null, prepare: { job: (async () => { calls++; }) as any, batch: (async () => { calls++; }) as any } });
    launcher.start(['lever:1', 'lever:2'], { allowLowFit: false });
    await until(() => state(launcher, 'lever:2').state === 'failed');
    expect(state(launcher, 'lever:1').state).toBe('failed'); expect(state(launcher, 'lever:1').reason).toBeTruthy(); expect(calls).toBe(0);
  });

  it('a job marked applied shows as applied (auto) or applied (manual) whatever the run state was', async () => {
    const db = mkdb();
    const launcher = createLauncher({ db, preparedDir: tmp, answersFile, llm: null, prepare: { job: (async (o: any) => result(o.id, { closed: Promise.resolve() })) as any } });
    launcher.start(['lever:1'], { allowLowFit: false }); launcher.start(['lever:2'], { allowLowFit: false });
    await until(() => state(launcher, 'lever:2').state === 'complete' && state(launcher, 'lever:1').state === 'complete');
    markJob(db, 'lever:1', 'applied', 'auto'); markJob(db, 'lever:2', 'applied', 'dashboard');
    expect(state(launcher, 'lever:1')).toMatchObject({ state: 'applied', via: 'auto' });
    expect(state(launcher, 'lever:2')).toMatchObject({ state: 'applied', via: 'manual' });
  });
});
