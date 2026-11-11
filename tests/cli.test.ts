import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, upsertJob } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { isInstallLifecycle } from '../src/apply/prepare.js';

// These tests spawn the REAL commands (`npm run prepare`, `tsx src/apply/prepare.ts`) against a temp db, a temp prepared/ dir and the local mock form.
// Nothing here touches the real data/jobs.db or prepared/ (JOB_RADAR_DB / JOB_RADAR_PREPARED point into a temp dir).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
const dbFile = path.join(tmp, 'cli.db'), prepared = path.join(tmp, 'prepared'), ans = path.join(tmp, 'answers.json');
const form = 'file://' + path.resolve('fixtures/forms/lever.html');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const TSX = path.resolve('node_modules/.bin/tsx');
const env = (extra: Record<string, string> = {}) => ({ ...process.env, JOB_RADAR_DB: dbFile, JOB_RADAR_PREPARED: prepared, ...extra });
const common = ['--headless', '--no-note', '--no-letter', '--answers', ans, '--url', form];

beforeAll(() => {
  const pdf = path.join(tmp, 'r.pdf'); fs.writeFileSync(pdf, '%PDF-1');
  fs.writeFileSync(ans, JSON.stringify({ name: 'Test Person', first_name: 'Test', last_name: 'Person', email: 'test@example.com', phone: '555-0100', city: 'Springfield', state: 'Illinois', country: 'United States',
    linkedin: 'https://linkedin.com/in/test', github: 'https://github.com/test', portfolio: 'https://test.example', school: 'State University', degree: "Bachelor's Degree", major: 'Computer Science', graduation_date: '2027-05', resumes: { A: pdf, B: pdf }, answers: {}, custom_answers: [] }));
  const db = openDb(dbFile);
  [['c1', 90], ['c2', 80], ['c3', 70]].forEach(([id, score]) => {
    upsertJob(db, { source: 'lever', id: id as string, company: 'Mock Co', title: `Software Engineer ${id}`, location: 'New York, NY', description: 'Build AI agents. New grads welcome.', url: `https://example.test/lever/${id}` }, 1, null);
    db.prepare('INSERT INTO scores (key,prompt_version,json,created_at) VALUES (?,?,?,?)').run(`lever:${id}`, cacheVersion('v3'), JSON.stringify({ score, track: 'A', fit_reasons: [], gaps: [], apply_priority: 'high' }), 'now');
    db.prepare("UPDATE jobs SET digest_date=?, status='seen' WHERE key=?").run(today, `lever:${id}`);
  });
  db.close();
});

// the review queue (prep_queue, filled from prepared/ files) makes a prepared job ineligible for --top, so each test starts from a clean queue and an empty prepared/
beforeEach(() => { fs.rmSync(prepared, { recursive: true, force: true }); const db = openDb(dbFile); db.exec('DELETE FROM prep_queue'); db.close(); });
const run = (cmd: string, args: string[], e = env()) => spawnSync(cmd, args, { env: e, encoding: 'utf8', timeout: 170000 });
const noSubmit = (out: string) => expect(out).not.toMatch(/Submit was clicked/);

describe.each([['npm run prepare', 'npm', ['run', 'prepare', '--']], ['tsx directly', TSX, ['src/apply/prepare.ts']]] as const)('real CLI: %s', (_n, cmd, pre) => {
  it('--top N prints "Preparing the" and the batch checklist; nothing submitted; real prepared/ untouched', () => {
    const before = fs.existsSync('prepared') ? fs.readdirSync('prepared').sort().join() : '';
    const r = run(cmd, [...pre, '--top', '2', ...common]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Preparing the 2 highest-fit unapplied jobs/); expect(r.stdout).toMatch(/lever:c1\s+score 90/); expect(r.stdout).not.toMatch(/lever:c3/);
    expect(r.stdout).toMatch(/BATCH CHECKLIST/); expect(r.stdout).toMatch(/Nothing was submitted/);
    noSubmit(r.stdout);
    expect(fs.existsSync('prepared') ? fs.readdirSync('prepared').sort().join() : '').toBe(before);
  }, 180000);
  it('--top with no number defaults to 5 (here: all 3 jobs)', () => {
    const r = run(cmd, [...pre, '--top', ...common]);
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/Preparing the 3 highest-fit unapplied jobs/);
  }, 180000);
  it('a source:id argument works', () => {
    const r = run(cmd, [...pre, 'lever:c1', ...common]);
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/FILLED \(\d+\)/); expect(r.stdout).toMatch(/Submit was NOT clicked \(blocked submit attempts: 0\)/);
  }, 180000);
  it('no argument prints usage and exits 1', () => {
    const r = run(cmd, [...pre]);
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/usage: npm run prepare/);
  }, 60000);
  it('--top 0 is rejected with a message, exit 1', () => {
    const r = run(cmd, [...pre, '--top', '0', ...common]);
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/--top needs a positive whole number/);
  }, 60000);
  // `npm run` itself overwrites npm_command with run-script, so the install-hook environment can only be simulated on the direct tsx call.
  it.skipIf(cmd === 'npm')('npm-install-style env exits 0 with a message (never silently)', () => {
    const r = run(cmd, [...pre], env({ npm_command: 'install', npm_lifecycle_event: 'prepare' }));
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/prepare: skipped, this is the npm "install" lifecycle hook/);
  }, 60000);
});

describe('lifecycle guard', () => {
  it('skips only for prepare under install/ci; `npm run prepare` (run-script) and other events never skip', () => {
    expect(isInstallLifecycle({ npm_lifecycle_event: 'prepare', npm_command: 'install' })).toBe(true);
    expect(isInstallLifecycle({ npm_lifecycle_event: 'prepare', npm_command: 'ci' })).toBe(true);
    expect(isInstallLifecycle({ npm_lifecycle_event: 'prepare', npm_command: 'run-script' })).toBe(false);
    expect(isInstallLifecycle({ npm_lifecycle_event: 'prepare', npm_command: 'run' })).toBe(false);   // an npm that names run-script differently must still run
    expect(isInstallLifecycle({ npm_lifecycle_event: 'test', npm_command: 'install' })).toBe(false);
    expect(isInstallLifecycle({})).toBe(false);
  });
});

// Audit of the other npm entry points: none may be a silent no-op, and each exits with a sensible code. Isolated: temp db, no API key, no real files written.
describe('other entry points never fail silently', () => {
  const iso = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, JOB_RADAR_DB: dbFile, JOB_RADAR_PREPARED: prepared, SPEND_FILE: path.join(tmp, 'spend.json'), ANTHROPIC_API_KEY: '', SYNC_HOST: '', SYNC_USER: '', ...extra });
  const go = (script: string, args: string[] = [], e = iso()) => spawnSync(TSX, [script, ...args], { env: e, encoding: 'utf8', timeout: 60000, cwd: process.cwd() });
  it.each([
    ['src/cli/mark.ts', [], 1, /usage: npm run mark/],
    ['src/cli/mark.ts', ['nope:1', 'applied'], 1, /no such job nope:1/],
    ['src/cli/audit.ts', [], 1, /usage: npm run audit/],
    ['src/cli/discover.ts', [], 1, /usage: npm run discover/],
    ['src/sync/pull.ts', [], 1, /SYNC_HOST and SYNC_USER must be set/],
    ['src/apply/prepare.ts', [], 1, /usage: npm run prepare/],
  ] as const)('%s %j -> exit %i with a message', (script, args, code, re) => {
    const r = go(script, [...args]);
    expect(r.status).toBe(code); expect(r.stdout + r.stderr).toMatch(re);
  }, 90000);
  it('mark on a real job exits 0 and says what it did (temp db)', () => {
    const r = go('src/cli/mark.ts', ['lever:c3', 'skip']);
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/marked lever:c3 skip/);
  }, 60000);
  it('answers:todo with a missing file prints a clear message, not a stack trace', () => {
    const r = go('src/apply/todo.ts', [path.join(tmp, 'missing.json')]);
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/not found/); expect(r.stderr).not.toMatch(/at .*node:/);
  }, 60000);
  it('prepare with a missing answers.json prints the fix, not a stack trace', () => {
    const r = go('src/apply/prepare.ts', ['lever:c1', '--headless', '--no-note', '--answers', path.join(tmp, 'missing.json')]);
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/Copy answers\.example\.json/); expect(r.stderr).not.toMatch(/\n\s+at /);
  }, 60000);
  it('scan --digest-only and reclassify on an empty-ish db say what they did', () => {
    // an EMPTY temp db, so --digest-only has nothing to write (it would otherwise write into the real digest/ folder)
    const empty = iso({ JOB_RADAR_DB: path.join(tmp, 'empty.db') });
    expect(go('src/cli/scan.ts', ['--digest-only'], empty).stdout).toMatch(/no stored digest rows/);
    expect(go('src/cli/reclassify.ts', [], empty).stdout).toMatch(/reclassified \d+ jobs/);
  }, 90000);
});

describe('incomplete runs are never reported as success (real CLI)', () => {
  it('an email that cannot be filled: loud NOT COMPLETE header at the top, reason shown, exit code 2 (npm run and tsx)', () => {
    const bad = path.join(tmp, 'answers-noemail.json'); fs.writeFileSync(bad, JSON.stringify({ ...JSON.parse(fs.readFileSync(ans, 'utf8')), email: 'REPLACE_ME@example.com' }));
    for (const [cmd, pre] of [['npm', ['run', 'prepare', '--']], [TSX, ['src/apply/prepare.ts']]] as const) {
      const r = run(cmd, [...pre, 'lever:c1', '--headless', '--no-note', '--no-letter', '--answers', bad, '--url', form]);
      expect(r.status).toBe(2);
      expect(r.stdout).toMatch(/NOT COMPLETE: EMAIL MISSING/); expect(r.stdout).toMatch(/email .*no value in answers\.json/); expect(r.stdout.indexOf('NOT COMPLETE')).toBeLessThan(r.stdout.indexOf('FILLED ('));
      expect(r.stdout).toMatch(/VERIFY \(re-read from the live form after filling\)/); expect(r.stdout).toMatch(/Exit code 2/); expect(r.stdout).not.toMatch(/Submit was clicked/);
    }
  }, 180000);
  it('--top batch: the checklist shows a VERIFY line per tab and a missing essential makes the batch exit 2', () => {
    const bad = path.join(tmp, 'answers-nophone.json'); fs.writeFileSync(bad, JSON.stringify({ ...JSON.parse(fs.readFileSync(ans, 'utf8')), phone: 'REPLACE_ME' }));
    const r = run(TSX, ['src/apply/prepare.ts', '--top', '2', '--headless', '--no-note', '--no-letter', '--answers', bad, '--url', form]);
    expect(r.status).toBe(2); expect(r.stdout).toMatch(/VERIFY: name filled \| email filled \| phone MISSING \| resume filled \| cover letter skipped/); expect(r.stdout).toMatch(/<-- NOT COMPLETE: phone:/);
  }, 180000);
  it('a complete run exits 0 and prints the screenshot path (written into the temp prepared dir only)', () => {
    const r = run(TSX, ['src/apply/prepare.ts', 'lever:c2', ...common]);
    expect(r.status).toBe(0); const m = /Screenshot of the filled form: (.+)/.exec(r.stdout); expect(m).toBeTruthy();
    expect(m![1].startsWith(prepared)).toBe(true); expect(fs.existsSync(m![1])).toBe(true);
  }, 180000);
});

describe('npm run answers:check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
  const goodAns = () => ({ ...JSON.parse(fs.readFileSync(ans, 'utf8')), answers: { work_authorization: 'Yes', sponsorship_needed: 'No' } });
  it('lists every null field and the required fields the last prepared form had no answer for; exits 1 when essentials or required answers are missing', () => {
    const f = path.join(dir, 'a.json'); fs.writeFileSync(f, JSON.stringify({ ...goodAns(), email: 'REPLACE_ME@example.com' }));
    fs.mkdirSync(path.join(dir, 'prep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prep', 'blank-questions.jsonl'), [{ ts: new Date().toISOString(), job: 'greenhouse:1', field: 'Where did you hear about us?', cause: 'empty', required: true, reason: 'no value in answers.json' }, { ts: new Date().toISOString(), job: 'greenhouse:1', field: 'Twitter', cause: 'empty', required: false, reason: 'no value in answers.json' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const r = spawnSync(TSX, ['src/apply/check.ts', f], { env: { ...process.env, JOB_RADAR_PREPARED: path.join(dir, 'prep') }, encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ESSENTIALS missing or placeholder \(1\)[\s\S]*! email/); expect(r.stdout).toMatch(/- answers\.eeo_gender/); expect(r.stdout).toMatch(/- answers\.eeo_orientation/);
    expect(r.stdout).toMatch(/REQUIRED fields the last prepared form\(s\) had no answer for \(1[\s\S]*\* Where did you hear about us\?/); expect(r.stdout).not.toMatch(/\* Twitter/);
  }, 90000);
  it('exits 0 when essentials are provided and nothing required was left blank', () => {
    const f = path.join(dir, 'ok.json'); fs.writeFileSync(f, JSON.stringify(goodAns()));
    const r = spawnSync(TSX, ['src/apply/check.ts', f], { env: { ...process.env, JOB_RADAR_PREPARED: path.join(dir, 'none') }, encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/ESSENTIALS missing or placeholder \(0\)/);
  }, 90000);
  it('a missing answers file is a clear message, exit 1', () => {
    const r = spawnSync(TSX, ['src/apply/check.ts', path.join(dir, 'nope.json')], { encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/not found/);
  }, 60000);
});
