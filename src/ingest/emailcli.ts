import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../store.js';
import { budgetedLlm } from '../spend.js';
import type { LlmFn } from '../scoring/scorer.js';
import { ingestEmails } from './email.js';
import { fetchImapMessages, imapConfigFromEnv, makeImapClient, parseSince } from './imap.js';
import { realFetch } from './net.js';

// usage: npm run ingest:email -- --dir <folder of .eml> | --imap [--since 7d] [--no-score]
const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
let raws: Buffer[] = [];
try {
  if (opt('--dir')) {
    const dir = opt('--dir')!;
    raws = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.eml')).sort().map((f) => fs.readFileSync(path.join(dir, f)));
  } else if (args.includes('--imap')) {
    const cfg = imapConfigFromEnv();
    raws = await fetchImapMessages(makeImapClient(cfg), { label: cfg.label, since: parseSince(opt('--since')) });
  } else { console.log('usage: npm run ingest:email -- --dir <folder> | --imap [--since 7d] [--no-score]'); process.exit(1); }
} catch (e) { console.log(`could not read emails: ${(e as Error).message}`); process.exit(1); }

let llm: LlmFn | null = null;
if (!args.includes('--no-score')) { try { llm = budgetedLlm('FEED', 'ingest:email'); } catch (e) { console.log(`scoring disabled: ${(e as Error).message}`); } }
const s = await ingestEmails(openDb(), raws, { fetch: realFetch, llm });
console.log(`emails read: ${s.emails}\nlinks found: ${s.links}\nresolved to a different URL: ${s.resolved} (ATS API fetches: ${s.atsFetched})\nadded (new): ${s.added} (filtered by prefilter: ${s.filtered}, scored: ${s.scored})\nduplicates: ${s.duplicates}\nskipped forbidden-host fetches: ${s.skippedForbidden}`);
if (s.errors.length) console.log('errors:\n' + s.errors.slice(0, 20).map((e) => '  ' + e).join('\n'));
