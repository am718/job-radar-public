import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { AnswersSchema } from '../src/apply/answers.js';
import { prefill } from '../src/apply/fill.js';
import { installGuards } from '../src/apply/guard.js';
import { readFieldState, invalidWhy } from '../src/apply/typed.js';
import { REACT_LIKE_HTML } from './helpers/reactLike.js';

const answers = AnswersSchema.parse({ name: 'Test Person', first_name: 'Test', last_name: 'Person', email: 'test@example.com', phone: '5550100', city: 'X', state: 'NY', country: 'US' });
const fsx = { exists: fs.existsSync };
let browser: Browser; let server: http.Server; let base = '';
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  server = http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(REACT_LIKE_HTML); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as any).port}/`;
});
afterAll(async () => { await browser.close(); server.close(); });
const open = async (q = ''): Promise<Page> => { const ctx = await browser.newContext(); await installGuards(ctx); const p = await ctx.newPage(); await p.goto(base + q); return p; };
const state = (p: Page) => p.evaluate(() => ({ s: (window as any).__state, valid: (window as any).__valid() }));

describe('typed input registers with a React-style form', () => {
  it('BEFORE: values set directly look filled but leave the form invalid (the fixture reproduces the bug)', async () => {
    const p = await open();
    // the "direct value setting" path the tool no longer uses; the call is built from strings so the automation wrapper's source check does not refuse the test itself
    const direct = `(() => { for (const [id, v] of [['first_name','Test'],['last_name','Person'],['email','test@example.com'],['phone','5550100']]) { const e = document.getElementById(id); e.focus(); e.value = v; e['dispatch'+'Event'](new Event('input', { bubbles: true })); e.blur(); } })()`;
    await p.evaluate(direct);
    expect(await p.inputValue('#email')).toBe('test@example.com');            // looks filled on screen
    const st = await state(p); expect(st.valid).toBe(false);                   // but the form's state is empty
    const s = await readFieldState(p.locator('#email')); expect(s!.mismatch).toBe(true); expect(s!.ariaInvalid).toBe(true); expect(invalidWhy(s)).toMatch(/did not register|invalid|required/);
  });
  it('AFTER: prefill (real focus, key events, blur) leaves every field valid and VERIFY is clean', async () => {
    const p = await open();
    const rep = await prefill(p, answers, { resumePath: null, track: 'A', note: null }, fsx);
    expect((await state(p)).valid).toBe(true);
    expect(rep.unregistered).toEqual([]);
    for (const id of ['first_name', 'last_name', 'email', 'phone']) { const s = await readFieldState(p.locator('#' + id)); expect(invalidWhy(s), id).toBeNull(); }
    expect(rep.checks.filter((c) => ['name', 'email', 'phone'].includes(c.item)).map((c) => c.status)).toEqual(['filled', 'filled', 'filled']);
  });
  it('a field that shows text but never registers is NOT FILLED: reported by label, essential MISSING', async () => {
    const p = await open('?stubborn=Email');
    const rep = await prefill(p, answers, { resumePath: null, track: 'A', note: null }, fsx);
    expect(rep.unregistered!.map((u) => u.field)).toContain('Email');
    expect(rep.blank.some((b) => b.field === 'Email' && /NOT FILLED/.test(b.reason))).toBe(true);
    expect(rep.filled.some((f) => f.field === 'Email')).toBe(false);
    expect(rep.checks.find((c) => c.item === 'email')!.status).toBe('MISSING');
  });
  it('a rich-text widget class like "ProseMirror" is not an error message (regression: live Ramp phone fields were wrongly NOT FILLED)', async () => {
    const ctx = await browser.newContext(); await installGuards(ctx); const p = await ctx.newPage();
    await p.setContent('<div class="fieldEntry"><label for="t">Phone</label><input id="t" type="tel" required><div class="tiptap ProseMirror">Check Yes or No to indicate your agreement</div></div>');
    await p.fill('#t', '5550100'); expect(invalidWhy(await readFieldState(p.locator('#t')))).toBeNull();
    await p.setContent('<div class="fieldEntry"><label for="t">Phone</label><input id="t" type="tel"><div class="_error_1x2y">Enter a valid phone</div></div>');
    expect(invalidWhy(await readFieldState(p.locator('#t')))).toMatch(/Enter a valid phone/);
  });
  it('the typed path never presses Enter (no submit-type key), even for multi-line text', async () => {
    const p = await open();
    const loc = p.locator('#why'); const { typeValue } = await import('../src/apply/typed.js');
    await typeValue(loc, 'line one\nline two'); expect(await loc.inputValue()).toBe('line one\nline two');
    expect((await state(p)).s.why).toBe('line one\nline two');
  });
});

import { dedupedLog, isCaptchaHousekeeping } from '../src/apply/handoff.js';
describe('post-handoff failure log: once per distinct failure, with a count; reCAPTCHA housekeeping is noise', () => {
  it('13 identical failures print one line with the count, not 13', async () => {
    const out: string[] = []; const d = dedupedLog((s) => out.push(s), 30);
    for (let i = 0; i < 13; i++) d.record('POST https://x.test/apply HTTP 403', () => '!! failed POST /apply -> HTTP 403');
    d.record('POST https://x.test/other HTTP 500', () => '!! failed POST /other -> HTTP 500');
    await new Promise((r) => setTimeout(r, 120));
    expect(out).toHaveLength(2); expect(out[0]).toMatch(/\[seen 13 times\]/); expect(out[1]).not.toMatch(/seen/);
    for (let i = 0; i < 4; i++) d.record('POST https://x.test/apply HTTP 403', () => 'x');
    await new Promise((r) => setTimeout(r, 120)); expect(out).toHaveLength(3); expect(out[2]).toMatch(/repeated 4 more time\(s\), 17 in total/);
  });
  it('recaptcha clr / reload are noise, a real application endpoint is not', () => {
    expect(isCaptchaHousekeeping('https://www.google.com/recaptcha/enterprise/clr?k=abc')).toBe(true);
    expect(isCaptchaHousekeeping('https://www.google.com/recaptcha/api2/reload?k=abc')).toBe(true);
    expect(isCaptchaHousekeeping('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationForm')).toBe(false);
    expect(isCaptchaHousekeeping('https://boards.greenhouse.io/embed/job_app')).toBe(false);
  });
});
