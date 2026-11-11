import 'dotenv/config';
import { openDb } from '../store.js';
import { budgetedLlm } from '../spend.js';
import { addJobFromUrl } from './add.js';
import { realFetch } from './net.js';
import type { LlmFn } from '../scoring/scorer.js';

// usage: npm run add -- <url> [--no-score]
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
if (!url) { console.log('usage: npm run add -- <job url> [--no-score]'); process.exit(1); }
let llm: LlmFn | null = null;
if (!args.includes('--no-score')) { try { llm = budgetedLlm('FEED', 'add'); } catch (e) { console.log(`scoring disabled: ${(e as Error).message}`); } }
const db = openDb();
const r = await addJobFromUrl(db, url, { fetch: realFetch, llm });
if (r.status === 'refused') console.log(`refused: ${r.reason}`);
else if (!r.ok) console.log(`failed: ${r.reason}`);
else console.log(`${r.status}: ${r.key} ${r.company ? `(${r.company}: ${r.title})` : ''}${r.score != null ? ` score ${r.score}` : ''}${r.reason ? `\n  ${r.reason}` : ''}`);
process.exit(r.ok || r.status === 'refused' ? 0 : 1);
