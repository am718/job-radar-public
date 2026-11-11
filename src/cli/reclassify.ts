import { openDb } from '../store.js';
import { prefilter } from '../prefilter.js';
import { locationTier } from '../location.js';
// Re-applies the CURRENT prefilter + location rules to every stored posting. No network, no LLM.
// BACK UP data/jobs.db FIRST (see README dev notes).
const db = openDb();
const rows = db.prepare('SELECT * FROM jobs').all() as any[];
const upd = db.prepare('UPDATE jobs SET filter_reason=?, tier=? WHERE key=?');
let changed = 0;
db.transaction(() => {
  for (const r of rows) {
    const pf = prefilter(r), tier = locationTier({ location: r.location, pay: r.pay ?? undefined, remote: !!r.remote });
    const reason = !pf.keep ? pf.reason! : tier == null ? 'location dropped' : null;
    if (reason !== r.filter_reason || tier !== r.tier) { upd.run(reason, tier, r.key); changed++; }
  }
})();
const pass = (db.prepare('SELECT count(*) c FROM jobs WHERE filter_reason IS NULL').get() as any).c;
console.log(`reclassified ${rows.length} jobs; ${changed} changed; ${pass} now pass the filters`);
