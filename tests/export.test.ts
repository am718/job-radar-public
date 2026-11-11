import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportPublic, isExcluded, EXCLUDED_FILES, LICENSE_TEXT } from '../src/cli/exportPublic.js';
import { ROOT } from '../src/userconfig.js';
import { scanDir, isExampleEmail, isFakePhone, isFixtureRoleEmail, listFiles, type ExportForbidden } from '../src/demo/leakcheck.js';

// No personal data and no network: the forbidden list is injected, the output goes to a temp dir.
// (values are assembled at runtime so that this test file itself, which is exported, never contains them)
const J = (...p: string[]) => p.join('');
const S = { text: J('zq-private-', 'marker-text'), part: J('Zorb', 'lax'), key: J('ashby:', '0000-secret', '-job-id'), co: J('Acme ', 'Realco'), mail: ['someone', 'realmail.io'].join('@'), phone: ['212', '867', '5309'].join('-') };
const forbidden: ExportForbidden = { personal: [S.text], nameParts: [S.part], data: [S.key], companies: [S.co], notes: [] };
const dirs: string[] = [];
const tmpOut = () => { const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-')), 'out'); dirs.push(path.dirname(d)); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const plant = (rel: string, text: string) => (out: string) => { fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), text); };

// The exporter needs the private repo (git ls-files). The exported copy has no .git, so these tests skip cleanly there.
const inRepo = fs.existsSync(path.join(ROOT, '.git'));
describe.skipIf(!inRepo)('export:public', () => {
  it('a clean export has no .git, none of the excluded or owner files, and has LICENSE, PUBLISHING.md and README.md', () => {
    const outDir = tmpOut(); const r = exportPublic({ outDir, forbidden });
    expect(r.report.findings).toEqual([]); expect(r.ok).toBe(true);
    const files = listFiles(outDir);
    expect(files).toEqual(expect.arrayContaining(['LICENSE', 'PUBLISHING.md', 'README.md', 'package.json', 'docs/index.html']));
    expect(fs.existsSync(path.join(outDir, '.git'))).toBe(false);
    for (const f of EXCLUDED_FILES) expect(files).not.toContain(f);
    for (const f of files) {
      expect(f.startsWith('eval/private/') || /^(data|prepared|digest|resumes|export)\//.test(f), f).toBe(false);
      expect(['profile.json', 'companies.json', 'job-radar.config.json', 'feeds.json', 'answers.json', '.env']).not.toContain(f);
    }
    expect(fs.readFileSync(path.join(outDir, 'LICENSE'), 'utf8')).toBe(LICENSE_TEXT);
    expect(LICENSE_TEXT).toMatch(/Copyright \(c\) 2026 The job-radar authors/);
    const pub = fs.readFileSync(path.join(outDir, 'PUBLISHING.md'), 'utf8'); expect(pub).toMatch(/git init/); expect(pub).toMatch(/Pages/);
  });
  it('refuses a non-empty output folder without force, and wipes only that folder with force', () => {
    const outDir = tmpOut(); fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'stale.txt'), 'x');
    expect(() => exportPublic({ outDir, forbidden })).toThrow(/--force/); expect(fs.existsSync(path.join(outDir, 'stale.txt'))).toBe(true);
    const r = exportPublic({ outDir, forbidden, force: true }); expect(r.ok).toBe(true); expect(fs.existsSync(path.join(outDir, 'stale.txt'))).toBe(false);
  });
  const mutations: [string, string, string, string][] = [
    ['an injected forbidden string', 'docs/notes.md', `hello ${S.text} here`, 'personal string'],
    ['an injected name part (whole word)', 'src/x.ts', `// by ${S.part}\n`, 'personal string'],
    ['an injected owner job key', 'src/y.ts', `const k = '${S.key}';`, 'owner data'],
    ['an email at a non-example domain', 'docs/contact.md', `write to ${S.mail}`, 'email'],
    ['a non-555 phone number', 'notes.txt', `call ${S.phone} now`, 'phone'],
    ['a forbidden company name in a Markdown file', 'docs/extra.md', `We applied to ${S.co} last week.`, 'real company name'],
  ];
  for (const [name, rel, text, cat] of mutations) {
    it(`planting ${name} fails the check, names file:line + category (not the value) and deletes the output`, () => {
      const outDir = tmpOut(); const logs: string[] = [];
      const r = exportPublic({ outDir, forbidden, beforeCheck: plant(rel, text), log: (s) => logs.push(s) });
      expect(r.ok).toBe(false); expect(fs.existsSync(outDir)).toBe(false);
      expect(r.report.findings.map((f) => `${f.file}|${f.category}`)).toContain(`${rel}|${cat}`);
      const out = logs.join('\n'); expect(out).toContain(`${rel}:`); expect(out).toContain(cat);
      for (const secret of [S.text, S.part, '0000-secret-job-id', S.mail, '867-5309', S.co]) expect(out).not.toContain(secret);
    });
  }
  it('company names are forbidden in Markdown and docs/ but allowed in code', () => {
    const outDir = tmpOut(); const r = exportPublic({ outDir, forbidden, beforeCheck: plant('src/fixture-ok.ts', `export const board = '${S.co}';`) });
    expect(r.ok).toBe(true);
  });
  it('a planted leak in a binary (latin1 bytes) is found', () => {
    const outDir = tmpOut(); const r = exportPublic({ outDir, forbidden, beforeCheck: (o) => fs.writeFileSync(path.join(o, 'docs/shots/x.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), Buffer.from(S.text)])) });
    expect(r.ok).toBe(false); expect(r.report.findings[0]).toMatchObject({ file: 'docs/shots/x.png', category: 'personal string' });
  });
});

describe('leak check rules', () => {
  it('example emails and 555-01xx phones are allowed, others are not', () => {
    const at = (u: string, d: string) => `${u}@${d}`;
    for (const d of ['example.com', 'example.org', 'sub.example.net', 'mail.example', 'host.test']) expect(isExampleEmail(at('a', d)), d).toBe(true);
    for (const d of ['gmail.com', 'example.com.evil.io', 'notexample.com']) expect(isExampleEmail(at('a', d)), d).toBe(false);
    expect(isFakePhone('(212) 555-0147')).toBe(true); expect(isFakePhone('(555) 123-4567')).toBe(true); expect(isFakePhone('415-555-1234')).toBe(true);
    expect(isFakePhone('212-555-0247')).toBe(true); expect(isFakePhone(['212', '867', '5309'].join('-'))).toBe(false);
    expect(isFixtureRoleEmail('tests/fixtures/a.html', at('careers', 'big.com'))).toBe(true); expect(isFixtureRoleEmail('README.md', at('careers', 'big.com'))).toBe(false); expect(isFixtureRoleEmail('tests/fixtures/a.html', at('jane', 'big.com'))).toBe(false);
  });
  it('scanDir reports file:line and counts, and name parts match whole words only', () => {
    const d = tmpOut(); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'a.md'), `line one\nBryant is fine\nand ${S.part} is not\n`);
    const r = scanDir(d, forbidden);
    expect(r.findings).toEqual([{ file: 'a.md', line: 3, category: 'personal string' }]); expect(r.found['personal string']).toBe(1); expect(r.checked['real company name']).toBe(1);
  });
  it('excluded paths', () => {
    for (const f of ['DECISIONS.md', 'eval/private/gold.jsonl', 'data/jobs.db', 'answers.json', '.env', 'prepared/x.md', 'export/a/b']) expect(isExcluded(f), f).toBe(true);
    for (const f of ['.env.example', 'answers.example.json', 'eval/sample/gold.jsonl', 'docs/index.html']) expect(isExcluded(f), f).toBe(false);
  });
});
