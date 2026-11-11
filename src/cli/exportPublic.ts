import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../userconfig.js';
import { scanDir, gatherExportForbidden, formatFinding, summarize, listFiles, type ExportForbidden, type ScanReport } from '../demo/leakcheck.js';

// npm run export:public [-- --out <dir>] [--force] [--verify]
// Copies the working tree (tracked + new, not ignored) into a clean folder WITHOUT git history, adds LICENSE and PUBLISHING.md, leak-checks every file and deletes the folder if anything is found.
// It never runs git init / push, never calls gh and never uploads anything: publishing is the owner's own step (see the generated PUBLISHING.md).

export const DEFAULT_OUT = 'export/job-radar-public';
/** Files that name the owner's real jobs and setup. */
export const EXCLUDED_FILES = ['DECISIONS.md', 'REVIEW.md', 'BLOCKED.md', 'docs/SETUP-MACBOOK.md', 'docs/EVAL.md', 'docs/failure_analysis.md'];
export const EXCLUDED_PREFIXES = ['eval/private/', 'data/', 'prepared/', 'digest/', 'resumes/', 'export/', '.git/', 'node_modules/'];
/** The owner's own files: never copied even if present and (mistakenly) tracked. Root level; `.env` and `.env.*` (except .env.example) at any depth. */
export const NEVER_COPY = ['profile.json', 'companies.json', 'job-radar.config.json', 'feeds.json', 'answers.json'];

export const LICENSE_TEXT = `MIT License

Copyright (c) 2026 The job-radar authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export const PUBLISHING_MD = `# Publishing checklist

This folder is a clean copy of the project with no git history. Nothing has been published: every step below is yours, by hand.

- [ ] **Review the folder.** Open it and skim the files, the README and the screenshots in \`docs/shots/\`. The export already ran an automated check for emails, phone numbers, your profile and answers, your git identity, your home path, your applied/skipped job ids and your private eval data, but you are the last line of defence.
- [ ] **Make it a new repository on this machine.**
  \`\`\`
  cd export/job-radar-public
  git init
  git add -A
  git commit -m "Initial commit"
  \`\`\`
  Check the author line of that commit (\`git log -1\`) and use a no-reply address if you do not want your real email public.
- [ ] **Create a NEW public GitHub repository** (do not reuse or flip the private one: its history holds early job-posting snapshots and your commit email). Leave it empty: no README, no licence, no .gitignore.
- [ ] **Push** to the new repository (\`git remote add origin <url>\`, then \`git branch -M main\` and \`git push -u origin main\`).
- [ ] **Turn on the demo site.** Repository Settings -> Pages -> Build and deployment -> Deploy from a branch -> Branch \`main\`, folder \`/docs\` -> Save.
- [ ] **Check the demo URL** (it appears on the Pages settings screen after a minute or two). It must show the SAMPLE DATA banner and invented companies only.
- [ ] Optional: add the repository and the demo link to your portfolio site and LinkedIn.

The private repository's history is never exported. To refresh the public copy later, run \`npm run export:public -- --force\` again and repeat the steps in a fresh clone or by copying the files over; never push the private repository.
`;

export interface ExportOptions {
  outDir?: string;
  /** Repository root to export (default: this repository). */
  root?: string;
  /** Wipe an existing non-empty output folder. */
  force?: boolean;
  /** After a clean export run tsc and vitest inside it. */
  verify?: boolean;
  /** Replace the forbidden list gathered from the owner's local files (tests inject synthetic values). */
  forbidden?: Partial<ExportForbidden>;
  /** Test hook: runs on the output folder after the copy and before the leak check (used to plant a leak). */
  beforeCheck?: (outDir: string) => void;
  log?: (s: string) => void;
}
export interface VerifyResult { tsc: { ok: boolean; output: string }; tests: { ok: boolean; passed: number; failed: number; skipped: number; files: string } }
export interface ExportResult { ok: boolean; outDir: string; files: string[]; report: ScanReport; verify?: VerifyResult }

function git(root: string, args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}
const startsWithAny = (rel: string, prefixes: string[]) => prefixes.some((p) => rel.startsWith(p));
export function isExcluded(rel: string): boolean {
  if (EXCLUDED_FILES.includes(rel) || startsWithAny(rel, EXCLUDED_PREFIXES) || NEVER_COPY.includes(rel)) return true;
  const base = rel.split('/').pop()!;
  return base === '.env' || (base.startsWith('.env.') && base !== '.env.example') || base === '.DS_Store' || rel.split('/').includes('.git');
}
/** tracked + new-but-not-ignored files, minus exclusions, minus anything gitignored (even if tracked), minus files deleted from the working tree. */
export function listExportFiles(root: string): string[] {
  const all = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const present = [...new Set(all)].filter((rel) => { try { return fs.lstatSync(path.join(root, rel)).isFile(); } catch { return false; } }).filter((rel) => !isExcluded(rel));
  const ignored = new Set(present.length ? git(root, ['check-ignore', '--no-index', '-z', '--stdin'], present.join('\0') + '\0').split('\0').filter(Boolean) : []);
  return present.filter((rel) => !ignored.has(rel)).sort();
}

function safeToWipe(outDir: string, root: string) {
  const o = path.resolve(outDir), r = path.resolve(root);
  if (o === path.parse(o).root || o === r || r.startsWith(o + path.sep) || o === process.env.HOME) throw new Error(`refusing to wipe ${o}`);
}
function removeDir(dir: string) { fs.rmSync(dir, { recursive: true, force: true }); }

export function runVerify(outDir: string, root: string, log: (s: string) => void = () => {}): VerifyResult {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const k of Object.keys(env)) if (k.startsWith('JOB_RADAR_') || k === 'EVAL_DIR') delete env[k];
  const link = path.join(outDir, 'node_modules');
  fs.symlinkSync(path.join(root, 'node_modules'), link, 'dir');
  try {
    log('verify: npx tsc --noEmit');
    const t = spawnSync('npx', ['tsc', '--noEmit'], { cwd: outDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const tscOut = `${t.stdout}${t.stderr}`.trim();
    log('verify: npx vitest run');
    const v = spawnSync('npx', ['vitest', 'run'], { cwd: outDir, env: { ...env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const out = `${v.stdout}\n${v.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    const line = /^\s*Tests\s+(.*)$/m.exec(out)?.[1] ?? '';
    const pick = (w: string) => Number(new RegExp(`(\\d+) ${w}`).exec(line)?.[1] ?? 0);
    const files = /^\s*Test Files\s+(.*)$/m.exec(out)?.[1]?.trim() ?? '';
    return { tsc: { ok: t.status === 0, output: tscOut }, tests: { ok: v.status === 0, passed: pick('passed'), failed: pick('failed'), skipped: pick('skipped'), files } };
  } finally { fs.rmSync(link, { force: true }); }
}

export function exportPublic(opts: ExportOptions = {}): ExportResult {
  const root = path.resolve(opts.root ?? ROOT), outDir = path.resolve(opts.outDir ?? path.join(root, DEFAULT_OUT)), log = opts.log ?? (() => {});
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    if (!opts.force) throw new Error(`${outDir} exists and is not empty; pass --force to wipe it`);
    safeToWipe(outDir, root); removeDir(outDir);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = listExportFiles(root).filter((rel) => !path.resolve(root, rel).startsWith(outDir + path.sep));
  for (const rel of files) { const dst = path.join(outDir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(root, rel), dst); }
  fs.writeFileSync(path.join(outDir, 'LICENSE'), LICENSE_TEXT); fs.writeFileSync(path.join(outDir, 'PUBLISHING.md'), PUBLISHING_MD);
  opts.beforeCheck?.(outDir);

  const forbidden: ExportForbidden = { personal: [], nameParts: [], data: [], companies: [], notes: [], ...(opts.forbidden ?? gatherExportForbidden(root)) };
  let report = scanDir(outDir, forbidden);
  const fail = (r: ScanReport): ExportResult => {
    for (const x of r.findings) log(formatFinding(x));
    log(summarize(r)); log(`LEAK CHECK FAILED: ${r.findings.length} finding(s); deleted ${outDir}`);
    removeDir(outDir); return { ok: false, outDir, files, report: r };
  };
  if (report.findings.length) return fail(report);
  const result: ExportResult = { ok: true, outDir, files: listFiles(outDir), report };

  if (opts.verify) {
    const before = new Set(listFiles(outDir));
    const v = runVerify(outDir, root, log); result.verify = v;
    for (const rel of listFiles(outDir)) if (!before.has(rel)) fs.rmSync(path.join(outDir, rel), { force: true });   // whatever the tests wrote
    for (const d of fs.readdirSync(outDir, { withFileTypes: true })) if (d.isDirectory()) pruneEmpty(path.join(outDir, d.name));
    report = scanDir(outDir, forbidden);   // the folder the owner receives is checked again after verification
    if (report.findings.length) return { ...fail(report), verify: v };
    result.report = report; result.files = listFiles(outDir); result.ok = v.tsc.ok && v.tests.ok;
  }
  return result;
}
function pruneEmpty(dir: string) { for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) pruneEmpty(path.join(dir, d.name)); if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); }

if (process.argv[1]?.endsWith('exportPublic.ts')) {
  const a = process.argv.slice(2), oi = a.indexOf('--out');
  const out = oi !== -1 ? a[oi + 1] : undefined;
  try {
    const r = exportPublic({ outDir: out ? path.resolve(out) : undefined, force: a.includes('--force'), verify: a.includes('--verify'), log: (s) => console.log(s) });
    if (!r.ok && !r.verify) process.exit(1);
    console.log(summarize(r.report));
    const top = new Map<string, number>(); for (const f of r.files) { const k = f.includes('/') ? f.split('/')[0] + '/' : f; top.set(k, (top.get(k) ?? 0) + 1); }
    console.log(`exported ${r.files.length} files to ${path.relative(process.cwd(), r.outDir) || r.outDir}`);
    console.log('top level: ' + [...top].map(([k, n]) => (k.endsWith('/') ? `${k}(${n})` : k)).join('  '));
    if (r.verify) {
      const { tsc, tests } = r.verify;
      console.log(`verify tsc --noEmit: ${tsc.ok ? 'PASS' : 'FAIL'}`); if (!tsc.ok) console.log(tsc.output.split('\n').slice(0, 30).join('\n'));
      console.log(`verify vitest: ${tests.ok ? 'PASS' : 'FAIL'}  ${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped  (files: ${tests.files})`);
    }
    console.log('Nothing was published. Next: read export/job-radar-public/PUBLISHING.md');
    if (!r.ok) process.exit(1);
  } catch (e) { console.error(`export failed: ${(e as Error).message}`); process.exit(1); }
}
