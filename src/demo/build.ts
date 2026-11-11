import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { renderPage } from '../dashboard/page.js';
import { statsFrom, type JobRow, type JobDetail } from '../dashboard/shared.js';

// PUBLIC DEMO BUILDER. Input: src/demo/sample.json ONLY (about 40 INVENTED jobs at invented companies). This module never reads data/jobs.db, answers.json, prepared/ or digest/
// and imports nothing that can (the real-data checker is src/demo/leakcheck.ts, a separate module). buildDemo() is pure: sample object in, HTML string out.
export const SampleSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  jobs: z.array(z.object({
    key: z.string().regex(/^sample:\d+$/), score: z.number().int().min(0).max(100), track: z.enum(['A', 'B']), company: z.string(), title: z.string(), pay: z.string(), arrangement: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
    posted: z.string().nullable(), fit: z.string(), status: z.enum(['new', 'seen', 'queued', 'applied', 'skip']), url: z.string().regex(/^https:\/\/example\.com\//), appliedOn: z.string().optional(),
  }).strict()),
  details: z.record(z.string(), z.object({ key: z.string(), strengths: z.array(z.string()), gaps: z.array(z.string()), priority: z.string(), note: z.string().nullable(), hasLetter: z.boolean(), url: z.string() }).strict()),
}).strict();
export type Sample = z.infer<typeof SampleSchema>;
export const BANNER = 'SAMPLE DATA: every company, job, score and application on this page is invented for the demo. Nothing here comes from real postings, real scores or a real person.';

export function buildDemo(raw: unknown): string {
  const s = SampleSchema.parse(raw);
  const rows: JobRow[] = s.jobs.map(({ appliedOn: _a, ...r }) => r);
  const byDay = new Map<string, number>(); for (const j of s.jobs) if (j.status === 'applied' && j.appliedOn) byDay.set(j.appliedOn, (byDay.get(j.appliedOn) ?? 0) + 1);
  const stats = statsFrom(rows.filter((r) => r.status === 'applied').length, [...byDay].map(([day, n]) => ({ day, n })), rows.filter((r) => r.status === 'queued').length, rows.filter((r) => r.status === 'skip').length, 0, s.asOf);
  const details: Record<string, JobDetail> = s.details;
  return renderPage({ mode: 'demo', title: 'job-radar (demo with sample data)', banner: BANNER, data: { asOf: s.asOf, rows, stats, details } });
}

if (process.argv[1]?.endsWith('build.ts')) {
  const out = process.argv[2] ?? 'docs/index.html';
  const html = buildDemo(JSON.parse(fs.readFileSync(new URL('./sample.json', import.meta.url), 'utf8')));
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, html);
  console.log(`demo built: ${out} (${html.length} bytes). Running the leak check...`);
  const { runLeakCheck } = await import('./leakcheck.js');
  const leaks = await runLeakCheck(out);
  if (leaks.length) { fs.rmSync(out, { force: true }); console.error(`DEMO BUILD FAILED: ${leaks.length} leak(s); the output was deleted:\n` + leaks.map((l) => `  - ${l}`).join('\n')); process.exit(1); }
  console.log('leak check passed: no email, phone, real company name or personal string in the demo output.');
}
