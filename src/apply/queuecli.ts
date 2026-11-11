import 'dotenv/config';
import { openDb } from '../store.js';
import { backfillQueue, dailyCap, etDate, preparedOn, queueRows, renderQueue } from './queue.js';
const db = openDb();
const imported = backfillQueue(db); if (imported) console.log(`(imported ${imported} job(s) prepared before the queue existed, from prepared/)\n`);
console.log(renderQueue(queueRows(db), { used: preparedOn(db, etDate()), cap: dailyCap() }));
