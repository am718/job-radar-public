import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { classify, classifyBlocked, robotsAllows } from '../src/apply/protection.js';
import { preflightUrl, preflightCompanies, type GetFn, type Fetched } from '../src/apply/preflight.js';
import { getSite, isExpired, isProtected, recordSite, siteStatus, EXPIRY_DAYS } from '../src/apply/sites.js';
import { pickTop, pickFillable, prepareJob } from '../src/apply/prepare.js';
import { buildDigest, type DigestRow } from '../src/digest.js';
import { byHandEntries } from '../src/pipeline.js';
import { openDb, upsertJob } from '../src/store.js';
import { cacheVersion } from '../src/scoring/scorer.js';
import { AnswersSchema } from '../src/apply/answers.js';
import type { Job } from '../src/types.js';

// Nothing here touches the real data/jobs.db or prepared/: every db is :memory: or a temp file, every prepared dir is a temp dir, and no test makes a real network request.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prot-'));
const FORM = '<html><body><form id="application-form"><input name="name"><input name="email"></form></body></html>';
const page = (html: string, status = 200, headers: Record<string, string> = {}): Fetched => ({ status, headers, body: html });

describe('classifier: one fixture per vendor signal', () => {
  it('AWS WAF: x-amzn-waf-action header (HTTP 202)', () => expect(classify({ status: 202, headers: { 'x-amzn-waf-action': 'challenge' }, body: '' })).toMatchObject({ protected: true, vendor: 'AWS WAF' }));
  it('AWS WAF: awswaf token script on a page without a form', () => expect(classify({ status: 200, headers: {}, body: '<script src="https://abc.token.awswaf.com/abc/challenge.js"></script>' })).toMatchObject({ protected: true, vendor: 'AWS WAF' }));
  it('AWS WAF: 405 from the WAF', () => expect(classify({ status: 405, headers: {}, body: '<script src="/awswaf/challenge.js"></script>' })).toMatchObject({ protected: true, vendor: 'AWS WAF' }));
  it('AWS WAF: seen in the requests the browser blocked/made', () => expect(classifyBlocked('captcha', 'bot check page', ['GET https://x.token.awswaf.com/y/challenge.js'])).toMatchObject({ protected: true, vendor: 'AWS WAF' }));
  it('Cloudflare: cf-mitigated header', () => expect(classify({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' })).toMatchObject({ protected: true, vendor: 'Cloudflare' }));
  it('Cloudflare: "Just a moment..." interstitial', () => expect(classify({ status: 503, headers: {}, body: '<title>Just a moment...</title><div id="challenge-form"></div>' })).toMatchObject({ protected: true, vendor: 'Cloudflare' }));
  it('reCAPTCHA: a visible checkbox widget on the form', () => expect(classify({ status: 200, body: '<form><div class="g-recaptcha" data-sitekey="abc"></div><input name="email"></form>' })).toMatchObject({ protected: true, vendor: 'reCAPTCHA' }));
  it('hCaptcha: widget on the form', () => expect(classify({ status: 200, body: '<form><div class="h-captcha" data-sitekey="abc"></div></form>' })).toMatchObject({ protected: true, vendor: 'hCaptcha' }));
  it('Turnstile: widget on the form', () => expect(classify({ status: 200, body: '<form><div class="cf-turnstile" data-sitekey="abc"></div></form>' })).toMatchObject({ protected: true, vendor: 'Cloudflare Turnstile' }));
  it('DataDome: captcha-delivery page', () => expect(classify({ status: 403, headers: { server: 'DataDome' }, body: '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>' })).toMatchObject({ protected: true, vendor: 'DataDome' }));
  it('PerimeterX: px-captcha block page', () => expect(classify({ status: 403, body: '<div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human</p>' })).toMatchObject({ protected: true, vendor: 'PerimeterX' }));
  it('Akamai Bot Manager: 403 with _abck cookie', () => expect(classify({ status: 403, headers: { 'set-cookie': '_abck=abc; Path=/, bm_sz=xyz' }, body: 'Access Denied' })).toMatchObject({ protected: true, vendor: 'Akamai Bot Manager' }));
  it('redirect from the ATS URL to a company careers page with no form', () => expect(classify({ status: 200, body: '<html><body><h1>Careers</h1></body></html>', ats: 'greenhouse', requestedUrl: 'https://job-boards.greenhouse.io/x/jobs/1', finalUrl: 'https://careers.example.com/jobs?gh_jid=1' })).toMatchObject({ protected: true, vendor: 'company careers page' }));
  it('NOT protected: an ordinary form page', () => expect(classify({ status: 200, body: FORM, ats: 'greenhouse', finalUrl: 'https://job-boards.greenhouse.io/x/jobs/1' }).protected).toBe(false));
  it('NOT protected: invisible reCAPTCHA badge / enterprise script on a normal form', () => {
    expect(classify({ status: 200, body: '<form><div class="g-recaptcha" data-size="invisible" data-sitekey="k"></div><input name="email"></form>' }).protected).toBe(false);
    expect(classify({ status: 200, body: '<script src="https://www.google.com/recaptcha/enterprise.js?render=k"></script><form><input name="email"></form>' }).protected).toBe(false);
  });
  it('NOT protected: Akamai/DataDome cookies on a normal 200 page (monitoring only)', () => expect(classify({ status: 200, headers: { 'set-cookie': '_abck=x, datadome=y' }, body: FORM }).protected).toBe(false));
  it('NOT protected: redirect to a company page that does contain the form', () => expect(classify({ status: 200, body: FORM, ats: 'greenhouse', finalUrl: 'https://careers.example.com/job' }).protected).toBe(false));
  it('NOT protected: Ashby SPA shell on the ATS host', () => expect(classify({ status: 200, body: '<div id="root"></div>', ats: 'ashby', finalUrl: 'https://jobs.ashbyhq.com/x/1/application' }).protected).toBe(false));
});

describe('robots.txt', () => {
  it('honours Disallow / Allow, longest match wins, "*" group', () => {
    const t = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n';
    expect(robotsAllows(t, '/jobs/1')).toBe(true); expect(robotsAllows(t, '/private/x')).toBe(false); expect(robotsAllows(t, '/private/ok/y')).toBe(true);
  });
  it('a group for our own agent beats "*"; empty Disallow allows everything', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: job-radar\nDisallow:\n', '/x')).toBe(true);
    expect(robotsAllows('User-agent: job-radar\nDisallow: /\n', '/x')).toBe(false);
  });
});

describe('preflight: read-only', () => {
  const stub = (routes: Record<string, Fetched>) => { const calls: string[] = []; const get: GetFn = async (u) => { calls.push(u); return routes[u] ?? (u.endsWith('/robots.txt') ? page('', 404) : page('nope', 404)); }; return { get, calls }; };
  it('only GETs, one page request per company, follows redirects by hand, classifies the final page', async () => {
    const { get, calls } = stub({ 'https://job-boards.greenhouse.io/x/jobs/1': { status: 302, headers: {}, body: '', location: 'https://careers.b.test/x' }, 'https://careers.b.test/x': page('<h1>no form</h1>') });
    const r = await preflightUrl('https://job-boards.greenhouse.io/x/jobs/1', 'greenhouse', { get, gapMs: 0 });
    expect(r.status).toBe('protected'); expect(r.vendor).toBe('company careers page');
    expect(calls.filter((c) => !c.endsWith('/robots.txt'))).toEqual(['https://job-boards.greenhouse.io/x/jobs/1', 'https://careers.b.test/x']);
  });
  it('the real GET function never sends a body or a non-GET method', () => {
    const src = fs.readFileSync('src/apply/preflight.ts', 'utf8');
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i); expect(src).toMatch(/method: 'GET'/);
  });
  it('robots.txt disallow: page is not fetched, result is unknown (not protected)', async () => {
    const { get, calls } = stub({ 'https://a.test/robots.txt': page('User-agent: *\nDisallow: /jobs', 200), 'https://a.test/jobs/1': page(FORM) });
    const r = await preflightUrl('https://a.test/jobs/1', 'lever', { get, gapMs: 0 });
    expect(r.status).toBe('unknown'); expect(r.robots).toBe('disallowed'); expect(calls).not.toContain('https://a.test/jobs/1');
  });
  it('network error -> unknown, never protected', async () => {
    const r = await preflightUrl('https://a.test/jobs/1', 'lever', { get: async () => { throw new Error('ECONNRESET'); }, gapMs: 0 });
    expect(r.status).toBe('unknown');
  });
  it('preflightCompanies: one request per company, writes apply_sites, reuses fresh rows, unknown never erases a definite status, manual wins', async () => {
    const db = openDb(':memory:');
    const jobs = [1, 2, 3].map((i) => ({ company: 'Acme', source: 'lever', id: String(i), url: `https://jobs.lever.co/acme/${i}` })).concat([{ company: 'Beta', source: 'lever', id: '9', url: 'https://jobs.lever.co/beta/9' }]);
    const { get, calls } = stub({ 'https://jobs.lever.co/acme/1/apply': page(FORM), 'https://jobs.lever.co/beta/9/apply': page('x', 202, { 'x-amzn-waf-action': 'challenge' }) });
    const r1 = await preflightCompanies(db, jobs, { get, gapMs: 0 });
    expect(calls.filter((c) => c.includes('/acme/')).length).toBe(1);
    expect(getSite(db, 'Acme')?.status).toBe('ok'); expect(getSite(db, 'Beta')).toMatchObject({ status: 'protected', vendor: 'AWS WAF' }); expect(r1).toHaveLength(2);
    const n = calls.length; const r2 = await preflightCompanies(db, jobs, { get, gapMs: 0 }); expect(calls.length).toBe(n); expect(r2.every((x) => x.cached)).toBe(true);
    const down: GetFn = async () => { throw new Error('offline'); };
    await preflightCompanies(db, jobs, { get: down, gapMs: 0, force: true }); expect(getSite(db, 'Beta')?.status).toBe('protected');
    recordSite(db, { company: 'Beta', ats: 'lever', status: 'ok', vendor: null, reason: 'by hand', source: 'manual' });
    await preflightCompanies(db, jobs, { get, gapMs: 0, force: true }); expect(getSite(db, 'Beta')?.status).toBe('ok');
  });
});

describe('apply_sites: expiry and the committed seed list', () => {
  it('a row expires after 14 days (and is then rechecked); manual rows do not expire', () => {
    const db = openDb(':memory:'); const t0 = new Date('2026-11-01T12:00:00Z');
    recordSite(db, { company: 'Zed', ats: 'lever', status: 'protected', vendor: 'Cloudflare', reason: 'r', source: 'preflight', checked_at: t0.toISOString() });
    const day = (n: number) => new Date(t0.getTime() + n * 86400_000);
    expect(siteStatus(db, 'Zed', day(13))).toMatchObject({ status: 'protected', fresh: true });
    expect(siteStatus(db, 'Zed', day(15))).toMatchObject({ fresh: false }); expect(isExpired({ checked_at: t0.toISOString(), source: 'preflight' }, day(EXPIRY_DAYS + 1))).toBe(true);
    recordSite(db, { company: 'Zed', ats: 'lever', status: 'ok', vendor: null, reason: 'hand', source: 'manual', checked_at: t0.toISOString() });
    expect(siteStatus(db, 'Zed', day(400))).toMatchObject({ status: 'ok', fresh: true });
  });
  it('an expired row with no seed entry is "unknown" (fillable) until rechecked; the seed list (Toast) applies without any row', () => {
    const db = openDb(':memory:');
    expect(siteStatus(db, 'Toast').status).toBe('protected'); expect(siteStatus(db, 'toast').vendor).toBe('AWS WAF');
    recordSite(db, { company: 'Zed', ats: 'lever', status: 'protected', vendor: 'x', reason: 'r', source: 'preflight', checked_at: '2020-01-01T00:00:00Z' });
    expect(isProtected(db, 'Zed')).toBe(false);   // expired: no longer excluded, so it is picked/rechecked again
    expect(siteStatus(db, 'Zed')).toMatchObject({ fresh: false, status: 'unknown' });
  });
  it('known-protected.json is valid, committed, and names Toast', () => {
    const k = JSON.parse(fs.readFileSync('src/apply/known-protected.json', 'utf8')); expect(k.sites.some((s: any) => s.company === 'Toast')).toBe(true);
  });
});

const mk = (source: 'greenhouse' | 'lever' | 'ashby', id: string, company: string, o: Partial<Job> = {}): Job => ({ source, id, company, title: `Software Engineer ${id}`, location: 'New York, NY', description: 'Build AI agents. New grads welcome.', url: `https://example.test/${source}/${id}`, ...o });
function seed() {
  const db = openDb(':memory:');
  const add = (source: 'greenhouse' | 'lever' | 'ashby', id: string, company: string, score: number) => {
    upsertJob(db, mk(source, id, company), 1, null);
    db.prepare('INSERT INTO scores (key,prompt_version,json,created_at) VALUES (?,?,?,?)').run(`${source}:${id}`, cacheVersion('v3'), JSON.stringify({ score, track: 'A', fit_reasons: [], gaps: [], apply_priority: 'high' }), 'now');
    db.prepare("UPDATE jobs SET digest_date='2026-11-02', status='seen' WHERE key=?").run(`${source}:${id}`);
  };
  add('greenhouse', 't1', 'Toast', 95); add('lever', 'a', 'Acme', 90); add('ashby', 'p1', 'Pinterest', 85); add('lever', 'b', 'Beta', 80); add('lever', 'c', 'Gamma', 70); add('lever', 'd', 'Delta', 60);
  return db;
}
describe('pickTop skips protected companies and backfills', () => {
  it('Toast (seed list) is skipped: 3 slots = the next three best, all fillable', () => {
    const db = seed();
    expect(pickTop(db, '2026-11-02', 3).map((p) => p.key)).toEqual(['lever:a', 'ashby:p1', 'lever:b']);
    recordSite(db, { company: 'Pinterest', ats: 'ashby', status: 'protected', vendor: 'Cloudflare', reason: 'r', source: 'preflight' });
    expect(pickTop(db, '2026-11-02', 3).map((p) => p.key)).toEqual(['lever:a', 'lever:b', 'lever:c']);
  });
  it('an expired protected row is rechecked by the next pick, and flips back to ok if the protection is gone', async () => {
    const db = seed(); recordSite(db, { company: 'Pinterest', ats: 'ashby', status: 'protected', vendor: 'Cloudflare', reason: 'r', source: 'preflight', checked_at: '2020-01-01T00:00:00Z' });
    recordSite(db, { company: 'Toast', ats: 'greenhouse', status: 'protected', vendor: 'AWS WAF', reason: 'r', source: 'manual' });
    const get: GetFn = async (u) => (u.endsWith('robots.txt') ? page('', 404) : page(FORM));
    const r = await pickFillable(db, '2026-11-02', 2, { get, gapMs: 0 });
    expect(r.picks.map((p) => p.key)).toEqual(['lever:a', 'ashby:p1']); expect(getSite(db, 'Pinterest')).toMatchObject({ status: 'ok' });
  });
  it('--include-protected overrides', () => { expect(pickTop(seed(), '2026-11-02', 2, undefined, { includeProtected: true }).map((p) => p.key)).toEqual(['greenhouse:t1', 'lever:a']); });
  it('pickFillable preflights candidates, learns a new protected company, and backfills; reports who was skipped', async () => {
    const db = seed(); const calls: string[] = [];
    const get: GetFn = async (u) => { calls.push(u); if (u.includes('ashby') || u.includes('/p1')) return page('x', 403, { 'cf-mitigated': 'challenge' }); return u.endsWith('robots.txt') ? page('', 404) : page(FORM); };
    const r = await pickFillable(db, '2026-11-02', 3, { get, gapMs: 0 });
    expect(r.picks.map((p) => p.key)).toEqual(['lever:a', 'lever:b', 'lever:c']);
    expect(r.skipped.map((p) => p.key)).toEqual(['greenhouse:t1', 'ashby:p1']);
    expect(getSite(db, 'Pinterest')).toMatchObject({ status: 'protected', vendor: 'Cloudflare' });
    const n = calls.length; await pickFillable(db, '2026-11-02', 3, { get, gapMs: 0 }); expect(calls.length).toBe(n);   // second run: fresh statuses, no new requests
  });
  it('preflight: false and includeProtected make no requests at all', async () => {
    const get: GetFn = async () => { throw new Error('network used'); };
    await expect(pickFillable(seed(), '2026-11-02', 3, { get, preflight: false })).resolves.toBeTruthy();
    await expect(pickFillable(seed(), '2026-11-02', 3, { get, includeProtected: true })).resolves.toBeTruthy();
  });
});

describe('a prepare run stopped by a blocker records the company as protected', () => {
  let browser: Browser, server: http.Server, port = 0;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end('<form><input name="name"><p>Please verify you are human. Press and hold to continue</p></form>'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port;
  });
  afterAll(async () => { await browser.close(); server.close(); });
  it('writes apply_sites (source "blocker") and the company is then not picked', async () => {
    const db = openDb(':memory:'); upsertJob(db, mk('lever', 'z', 'Wall Co'), 1, null);
    db.prepare('INSERT INTO scores (key,prompt_version,json,created_at) VALUES (?,?,?,?)').run('lever:z', cacheVersion('v3'), JSON.stringify({ score: 99, track: 'A', fit_reasons: [], gaps: [], apply_priority: 'high' }), 'now'); db.prepare("UPDATE jobs SET digest_date='2026-11-02', status='seen' WHERE key='lever:z'").run();
    const answers = AnswersSchema.parse({ name: 'T P', first_name: 'T', last_name: 'P', email: 't@example.com', phone: '555', city: 'X', state: 'NY', country: 'US', linkedin: 'https://l', github: 'https://g', portfolio: 'https://p', school: 'S', graduation_date: '2027-05' });
    expect(pickTop(db, '2026-11-02', 1).map((p) => p.key)).toEqual(['lever:z']);
    const r = await prepareJob({ db, id: 'lever:z', answers, llm: null, noNote: true, noLetter: true, noShot: true, headless: true, urlOverride: `http://127.0.0.1:${port}/`, browser, preparedDir: tmp, log: () => {} });
    expect(r.blocker?.kind).toBe('captcha');
    expect(getSite(db, 'Wall Co')).toMatchObject({ status: 'protected', source: 'blocker', ats: 'lever' });
    expect(pickTop(db, '2026-11-02', 1)).toEqual([]);
  }, 60000);
});

describe('digest: "Apply by hand (bot protected)"', () => {
  const row = (key: string, company: string, score: number): DigestRow => ({ key, company, title: 'Software Engineer', location: 'New York, NY', pay: null, url: `https://careers.${company.toLowerCase()}.com/jobs?gh_jid=1`, tier: 1, score: { score, track: 'A', fit_reasons: [], gaps: [], apply_priority: 'high' } as any });
  it('lists protected jobs with the apply link and either the prepared files or the command to make them', () => {
    const toast = row('greenhouse:t1', 'Toast', 88);
    const md = buildDigest([toast, row('lever:a', 'Acme', 70)], '2026-11-02', 2, 0, [], [{ row: toast, vendor: 'AWS WAF', reason: 'r', note: null, letterPdf: null }]);
    expect(md).toMatch(/# Apply by hand \(bot protected\) \(1\)/); expect(md).toMatch(/Toast - Software Engineer .*protection: AWS WAF \| apply: https:\/\/careers\.toast\.com/);
    expect(md).toMatch(/npm run letter -- greenhouse:t1/);
    const md2 = buildDigest([toast], '2026-11-02', 1, 0, [], [{ row: toast, vendor: 'AWS WAF', reason: null, note: '/p/greenhouse-1.md', letterPdf: '/p/TP_Cover_Letter_Toast.pdf' }]);
    expect(md2).toMatch(/cover letter PDF: \/p\/TP_Cover_Letter_Toast\.pdf \| tailored note: \/p\/greenhouse-1\.md/);
  });
  it('no section when nothing is protected', () => expect(buildDigest([row('lever:a', 'Acme', 70)], '2026-11-02', 1)).not.toMatch(/Apply by hand/));
  it('byHandEntries picks protected companies (40+ today, or still-open), skips applied/skip, and finds existing files', () => {
    const db = seed(); const dir = fs.mkdtempSync(path.join(tmp, 'bh-'));
    fs.writeFileSync(path.join(dir, 'greenhouse-t1.md'), 'n'); fs.writeFileSync(path.join(dir, 'TP_Cover_Letter_Toast.pdf'), '%PDF'); fs.writeFileSync(path.join(dir, 'TP_Cover_Letter_Toast.pdf.job'), 'greenhouse:t1');
    const rows = [row('greenhouse:t1', 'Toast', 88), row('lever:a', 'Acme', 70), row('ashby:p1', 'Pinterest', 30)];
    const e = byHandEntries(db, rows, [], dir);
    expect(e.map((x) => x.row.key)).toEqual(['greenhouse:t1']); expect(e[0].letterPdf).toBe(path.resolve(dir, 'TP_Cover_Letter_Toast.pdf')); expect(e[0].note).toBe(path.resolve(dir, 'greenhouse-t1.md'));
    db.prepare("UPDATE jobs SET status='skip' WHERE key='greenhouse:t1'").run();
    expect(byHandEntries(db, rows, [], dir)).toEqual([]);
  });
});

describe('real CLIs (temp db + temp prepared dir)', () => {
  const dbFile = path.join(tmp, 'cli.db'), prepared = path.join(tmp, 'cli-prepared');
  const env = { ...process.env, JOB_RADAR_DB: dbFile, JOB_RADAR_PREPARED: prepared };
  const run = (args: string[]) => spawnSync('npm', ['run', '-s', ...args], { env, encoding: 'utf8', timeout: 120000 });
  beforeAll(() => { const db = openDb(dbFile); upsertJob(db, mk('lever', 'x', 'Acme'), 1, null); db.close(); });
  it('npm run sites: prints the table (seed row for Toast included) and never touches the real db', () => {
    const r = run(['sites']); expect(r.status).toBe(0); expect(r.stdout).toMatch(/company\s+ATS\s+status\s+vendor/); expect(r.stdout).toMatch(/Toast\s+greenhouse\s+protected\s+AWS WAF/);
  });
  it('npm run sites -- mark <company> protected|ok corrects it by hand', () => {
    expect(run(['sites', '--', 'mark', 'Acme', 'protected']).stdout).toMatch(/Acme: marked protected/);
    expect(run(['sites']).stdout).toMatch(/Acme\s+lever\s+protected\s+marked by hand/);
    expect(run(['sites', '--', 'mark', 'Acme', 'ok']).stdout).toMatch(/Effective status now: ok/);
    const bad = run(['sites', '--', 'mark', 'Acme', 'maybe']); expect(bad.status).toBe(1); expect(bad.stderr).toMatch(/usage/);
    const nope = run(['sites', '--', 'mark', 'Nonexistent Co', 'ok']); expect(nope.status).toBe(1);
  }, 120000);
  it('npm run letter with no argument prints usage (exit 1), not silence', () => { const r = run(['letter']); expect(r.status).toBe(1); expect(r.stderr).toMatch(/usage: npm run letter/); });
  it('the real db and real prepared/ were not written by these tests', () => { expect(fs.existsSync(path.join(prepared, 'x'))).toBe(false); expect(path.resolve(dbFile).startsWith(os.tmpdir()) || path.resolve(dbFile).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true); });
});
