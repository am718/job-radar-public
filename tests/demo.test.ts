import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import Database from 'better-sqlite3';
import { buildDemo, BANNER, SampleSchema } from '../src/demo/build.js';
import { findLeaks, gatherForbidden, EMAIL, PHONE } from '../src/demo/leakcheck.js';

const sample = JSON.parse(fs.readFileSync('src/demo/sample.json', 'utf8'));
const html = buildDemo(sample);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'));

describe('demo: sample data only', () => {
  it('the fixture is about 40 invented jobs, schema-valid, with example.com links', () => {
    const s = SampleSchema.parse(sample); expect(s.jobs.length).toBeGreaterThanOrEqual(38); expect(s.jobs.length).toBeLessThanOrEqual(45);
    expect(s.jobs.every((j) => j.key.startsWith('sample:') && j.url.startsWith('https://example.com/'))).toBe(true);
    expect(new Set(s.jobs.map((j) => j.company)).size).toBeGreaterThan(10); expect(s.jobs.map((j) => j.status)).toEqual(expect.arrayContaining(['new', 'seen', 'queued', 'applied', 'skip']));
  });
  it('building touches no file and imports nothing that can read real data', () => {
    const reads: string[] = []; const o = { r: fs.readFileSync, o: fs.openSync, d: fs.readdirSync };
    (fs as any).readFileSync = (...a: any[]) => { reads.push(String(a[0])); return (o.r as any)(...a); }; (fs as any).openSync = (...a: any[]) => { reads.push(String(a[0])); return (o.o as any)(...a); }; (fs as any).readdirSync = (...a: any[]) => { reads.push(String(a[0])); return (o.d as any)(...a); };
    try { buildDemo(sample); } finally { Object.assign(fs, { readFileSync: o.r, openSync: o.o, readdirSync: o.d }); }
    expect(reads).toEqual([]);
    for (const f of ['src/demo/build.ts', 'src/dashboard/page.ts', 'src/dashboard/shared.ts']) {
      const src = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      expect(src, f).not.toMatch(/jobs\.db|better-sqlite3|store\.js|answers\.json|digest\/|prepared\/|DB_PATH/);
    }
  });
  it('the page is self-contained: banner says sample data, no external resource, no analytics', () => {
    expect(html).toContain(BANNER); expect(html).toMatch(/SAMPLE DATA/);
    expect(html).not.toMatch(/<link\b|<img\b[^>]*src=["']https?:|<script[^>]+src=|@import|fonts\.googleapis|google-analytics|googletagmanager|gtag\(|posthog|plausible|segment\.com/i);
    const urls = html.match(/https?:\/\/[^\s"'<>\\]+/g) ?? []; expect(urls.filter((u) => !/^https:\/\/example\.com\//.test(u) && u !== 'http://www.w3.org/2000/svg')).toEqual([]);   // the SVG namespace id is not a request
    expect(html).toMatch(/Content-Security-Policy/);
  });
});

describe('demo leak check', () => {
  const forbidden = { companies: ['Acme Realco', 'Scale'], strings: ['Jane Q Public', 'jqp-private-note-text'] };
  it('the shipped demo output is clean', () => { expect(findLeaks(html, forbidden)).toEqual([]); expect(html.match(EMAIL)).toBeNull(); expect(html.match(PHONE)).toBeNull(); });
  it('fails on an email, a phone number, a real company and an answers.json string', () => {
    const bad = html.replace('</main>', '<p>write to jane@example.org or call (212) 555-0147, ask Acme Realco, signed Jane Q Public</p></main>');
    const leaks = findLeaks(bad, forbidden).join('\n');
    expect(leaks).toMatch(/email address: jane@example\.org/); expect(leaks).toMatch(/phone number: \(212\) 555-0147/); expect(leaks).toMatch(/real company name: Acme Realco/); expect(leaks).toMatch(/string from answers\.json/);
    expect(leaks).not.toContain('Jane Q Public');                       // the personal value itself is never echoed into logs
  });
  it('a real company hidden inside the inlined data is caught, and a name like "Scale" does not trip on CSS / viewport markup', () => {
    const tampered = JSON.parse(JSON.stringify(sample)); tampered.jobs[0].company = 'Acme Realco'; tampered.jobs[0].fit = 'dial 212-555-0188';
    const leaks = findLeaks(buildDemo(tampered), forbidden); expect(leaks.join('|')).toMatch(/Acme Realco/); expect(leaks.join('|')).toMatch(/phone number/);
    expect(html).toMatch(/initial-scale/); expect(findLeaks(html, { companies: ['Scale'], strings: [] })).toEqual([]);
  });
  it('gatherForbidden reads companies.json, every company in the local DB and personal answers.json fields (not generic ones like city)', () => {
    const cj = path.join(tmp, 'companies.json'); fs.writeFileSync(cj, JSON.stringify([{ name: 'Realcorp One' }]));
    const dbp = path.join(tmp, 'j.db'); const db = new Database(dbp); db.exec('CREATE TABLE jobs (company TEXT)'); db.prepare('INSERT INTO jobs VALUES (?)').run('Digest Company Two'); db.close();
    const ap = path.join(tmp, 'a.json'); fs.writeFileSync(ap, JSON.stringify({ name: 'Pat Example', email: 'pat@example.org', city: 'New York', resumes: { A: 'resumes/pat-a.pdf' }, custom_answers: [{ match: 'x', answer: 'a long personal answer here' }] }));
    const { forbidden } = gatherForbidden({ companies: cj, db: dbp, answers: ap });
    expect(forbidden.companies).toEqual(expect.arrayContaining(['Realcorp One', 'Digest Company Two']));
    expect(forbidden.strings).toEqual(expect.arrayContaining(['Pat Example', 'pat@example.org', 'resumes/pat-a.pdf', 'a long personal answer here'])); expect(forbidden.strings).not.toContain('New York');
    expect(findLeaks('<p>Digest Company Two is hiring</p>', forbidden).join()).toMatch(/Digest Company Two/);
    expect(gatherForbidden({ companies: '/nonexistent/c.json', db: '/nonexistent/x.db', answers: '/nonexistent/a.json' }).notes).toHaveLength(3);   // missing files are reported, not fatal (e.g. CI)
  });
  it('the real local data (if present) is not in the committed demo build', () => {
    const { forbidden } = gatherForbidden(); const leaks = findLeaks(html, forbidden); expect(leaks).toEqual([]);
  });
});

describe('demo page in a browser', () => {
  let browser: Browser; beforeAll(async () => { browser = await chromium.launch({ headless: true }); }); afterAll(async () => { await browser.close(); });
  it('same table, filters and counters as the dashboard, read-only (no mark buttons), works from a file with no network', async () => {
    const f = path.join(tmp, 'index.html'); fs.writeFileSync(f, html);
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 }, offline: true })).newPage(); const failed: string[] = []; page.on('requestfailed', (r) => failed.push(r.url()));
    await page.goto('file://' + f); await page.waitForSelector('tbody tr');
    expect(await page.locator('tbody tr').count()).toBe(sample.jobs.length);
    const cards = await page.locator('#cards').innerText(); expect(cards).toMatch(/applied total/); expect(cards).toMatch(/queued for review/); expect(cards.replace(/\s+/g, ' ')).toMatch(/7 applied total/);
    await page.selectOption('#f-status', 'queued'); expect(await page.locator('tbody tr').count()).toBe(sample.jobs.filter((j: any) => j.status === 'queued').length);
    await page.selectOption('#f-status', ''); await page.check('#f-week'); expect(await page.locator('tbody tr').count()).toBe(sample.jobs.filter((j: any) => j.posted && Date.parse('2026-11-06T12:00:00Z') - Date.parse(j.posted + 'T12:00:00Z') <= 7 * 86400000).length);
    await page.uncheck('#f-week'); await page.locator('tbody tr').first().click(); await page.waitForSelector('#detail h2');
    expect(await page.getByRole('button', { name: /Mark applied|Skip/ }).count()).toBe(0);
    expect(await page.locator('#chart svg rect').count()).toBe(14); expect(failed).toEqual([]);
  });
});

describe('README eval numbers are the measured ones', () => {
  it('every percentage quoted in the demo/eval section appears in the generated Results table', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    const sec = /## Demo and dashboard[\s\S]*?(?=\n## )/.exec(readme)?.[0] ?? ''; expect(sec.length).toBeGreaterThan(200);
    const results = /## Results[\s\S]*?(?=\n## )/.exec(readme)![0];
    const nums = (sec.match(/\d+(\.\d+)?%/g) ?? []); expect(nums.length).toBeGreaterThan(2);
    for (const n of nums) expect(results, n).toContain(n);
  });
});
