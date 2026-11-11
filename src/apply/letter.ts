import 'dotenv/config';
import { openDb } from '../store.js';
import { loadAnswers } from './answers.js';
import { loadProfile } from '../scoring/scorer.js';
import { coverLetter, writeLetterFiles } from './coverletter.js';
import { findJob } from './prepare.js';
import { PREPARED_DIR, prepareByHand, renderByHand } from './byhand.js';
import { digestRowsFor, stillOpenRows, byHandEntries, todayET } from '../pipeline.js';

const USAGE = 'usage: npm run letter -- <source:id>            (cover letter only; prints the PDF path)\n       npm run letter -- --protected [--date YYYY-MM-DD]   (note + letter for every bot-protected job in the digest)';
const a = process.argv.slice(2);
const flags = new Set(a.filter((x) => x.startsWith('--')));
const dateIdx = a.indexOf('--date');
const pos = a.filter((x, i) => !x.startsWith('--') && !(dateIdx >= 0 && i === dateIdx + 1));
if (!pos[0] && !flags.has('--protected')) { console.error(USAGE); process.exit(1); }

const db = openDb();
const answers = loadAnswers(process.env.JOB_RADAR_ANSWERS ?? 'answers.json');
let llm: import('../scoring/scorer.js').LlmFn | null = null, llmWhy: string | undefined;
try { const { budgetedLlm } = await import('../spend.js'); llm = budgetedLlm('APPLY', 'apply note+letter', { maxTokens: 2500, noThinking: true }); } catch (e) { llmWhy = (e as Error).message; console.error(`!! No model available: ${llmWhy}`); }

if (flags.has('--protected')) {
  let day = dateIdx >= 0 ? a[dateIdx + 1] : todayET();
  if (!(db.prepare('SELECT 1 FROM jobs WHERE digest_date=?').get(day))) { const last = db.prepare('SELECT max(digest_date) d FROM jobs').get() as { d: string | null }; if (last.d) day = last.d; }
  const rows = digestRowsFor(db, day, undefined, undefined, todayET());
  const keys = byHandEntries(db, rows, stillOpenRows(db, day, undefined, undefined, todayET())).map((e) => e.row.key);   // exactly the list in the digest's "Apply by hand" section
  if (!keys.length) { console.log('no bot-protected jobs in the digest'); process.exit(0); }
  const items = [];
  for (const k of keys) items.push(await prepareByHand(db, k, answers, llm, { llmWhy }));
  console.log(renderByHand(items));
  process.exit(items.some((i) => !i.letterPdf) ? 2 : 0);
}

const job = findJob(db, pos[0]);
const l = await coverLetter(db, job, loadProfile().summary, llm, answers.name ?? undefined);
if (!l.letter) { console.error(`no cover letter for ${job.key}: ${llmWhy && l.why === 'no LLM configured' ? llmWhy : l.why}`); process.exit(2); }
const contact = [answers.email, answers.phone, answers.linkedin].filter((x) => x && !/^REPLACE/i.test(x)).join('  |  ');
const f = await writeLetterFiles(PREPARED_DIR(), job, l.letter, { name: answers.name ?? '', contact });
console.log(`${job.company} - ${job.title} (${job.key})${l.cached ? ' [cached letter]' : ''}\ncover letter PDF: ${f.pdf}\ncover letter text: ${f.md}`);
