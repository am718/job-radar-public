import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { LlmFn } from '../scoring/scorer.js';
import { loadProfile } from '../scoring/scorer.js';
import { tailoredNote } from './note.js';
import { coverLetter, writeLetterFiles } from './coverletter.js';
import { findJob } from './prepare.js';
import type { Answers } from './answers.js';

export { PREPARED_DIR, byHandFiles, type ByHandFiles } from './byfiles.js';
import { PREPARED_DIR } from './byfiles.js';

export interface ByHandItem { key: string; company: string; title: string; url: string; note: string | null; letterPdf: string | null; letterMd: string | null; why: string[] }

/** For a job we will NOT open a form for: writes the tailored note (prepared/<source>-<id>.md) and the cover letter (md + PDF) so you can paste/upload them yourself. No browser page is opened on the job. */
export async function prepareByHand(db: Database.Database, key: string, answers: Pick<Answers, 'name' | 'email' | 'phone' | 'linkedin'>, llm: LlmFn | null, o: { dir?: string; noteToo?: boolean; llmWhy?: string; log?: (s: string) => void } = {}): Promise<ByHandItem> {
  const dir = o.dir ?? PREPARED_DIR();
  const job = findJob(db, key), profile = loadProfile().summary, why: string[] = [];
  let notePath: string | null = null, letterPdf: string | null = null, letterMd: string | null = null;
  if (o.noteToo !== false) {
    const n = await tailoredNote(db, job, profile, llm, answers.name ?? undefined);
    if (n.note) { fs.mkdirSync(dir, { recursive: true }); notePath = path.resolve(dir, `${job.source}-${job.id}.md`); fs.writeFileSync(notePath, `# ${job.company} - ${job.title}\n\n${job.url}\n\n## Tailored note (facts only from profile.json)\n\n${n.note}\n\n(Apply by hand: this page is bot-protected, so nothing was filled. Paste the note, upload the cover letter PDF.)\n`); }
    else why.push(`note: ${n.why ?? 'none'}`);
  }
  const l = await coverLetter(db, job, profile, llm, answers.name ?? undefined);
  if (l.letter) {
    const contact = [answers.email, answers.phone, answers.linkedin].filter((x) => x && !/^REPLACE/i.test(x)).join('  |  ');
    const f = await writeLetterFiles(dir, job, l.letter, { name: answers.name ?? '', contact });
    letterPdf = path.resolve(f.pdf); letterMd = path.resolve(f.md);
  } else why.push(`letter: ${o.llmWhy && l.why === 'no LLM configured' ? o.llmWhy : l.why ?? 'none'}`);
  return { key: job.key, company: job.company, title: job.title, url: job.url, note: notePath, letterPdf, letterMd, why };
}

export function renderByHand(items: ByHandItem[]): string {
  if (!items.length) return '';
  const L = ['', `=== APPLY BY HAND (${items.length}): bot-protected pages the tool will not open or fill. Everything below is ready to paste / upload.`];
  for (const i of items) {
    L.push(`- ${i.company} - ${i.title} (${i.key})`, `    apply link: ${i.url}`, `    cover letter PDF: ${i.letterPdf ?? 'NOT GENERATED'}`, `    tailored note:    ${i.note ?? 'NOT GENERATED'}`);
    for (const w of i.why) L.push(`    (${w})`);
  }
  return L.join('\n');
}
