import crypto from 'node:crypto';
import { openDb } from '../store.js';
// usage: tsx src/cli/audit.ts Datadog Spotify Ramp   -> 20 random (seeded) dropped titles per company per drop reason
if (!process.argv.slice(2).length) { console.error('usage: npm run audit -- <Company> [Company ...]   (shows 20 seeded-random dropped titles per drop reason)'); process.exit(1); }
const db = openDb();
const h = (s: string) => crypto.createHash('sha1').update('audit' + s).digest('hex');
for (const company of process.argv.slice(2)) {
  console.log(`\n######## ${company}`);
  for (const reason of ['excluded title', '3+ years required', 'no track keyword', 'location dropped']) {
    const all = db.prepare('SELECT key,title,location FROM jobs WHERE company=? AND filter_reason=?').all(company, reason) as any[];
    console.log(`\n--- ${reason} (${all.length} total, showing ${Math.min(20, all.length)})`);
    all.sort((a, b) => h(a.key).localeCompare(h(b.key))).slice(0, 20).forEach((r) => console.log(`  ${r.title}${reason === 'location dropped' ? '  @ ' + r.location : ''}`));
  }
}
