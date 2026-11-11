import { openDb } from '../store.js';
import { markJob, isMarkStatus } from '../marking.js';
const [key, status] = process.argv.slice(2);
if (!key || !isMarkStatus(status)) { console.error('usage: npm run mark -- <source:id> applied|skip'); process.exit(1); }
const r = markJob(openDb(), key, status);
if (!r.ok) { console.error(`no such job ${key} (nothing marked)`); process.exit(1); }
console.log(r.changed ? `marked ${key} ${status}` : `${key} was already ${status} (nothing changed)`);
