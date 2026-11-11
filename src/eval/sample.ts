import fs from 'node:fs';
import { evalPaths } from './paths.js';
import crypto from 'node:crypto';
import { openDb } from '../store.js';

// Seeded, reproducible stratified sample, frozen WITH full text into eval/candidates.jsonl (gitignored).
// If candidates already exist they are KEPT unchanged and the set is extended up to the targets (no duplicates).
// usage: npm run sample -- [--targets tier1=48,tier2=43,tier3+=32,obvious-skip=27] [--cap 6]
// Refuses to run if eval/gold.jsonl exists (labels would no longer match the candidate set) unless --force.
const P = evalPaths();
const a = process.argv.slice(2);
const arg = (n: string, d: string) => (a.includes(`--${n}`) ? a[a.indexOf(`--${n}`) + 1] : d);
if (!a.includes('--force') && fs.existsSync(P.gold) && fs.readFileSync(P.gold, 'utf8').trim()) {
  console.error(`${P.gold} exists: refusing to change candidates (use --force).`); process.exit(1);
}
const targets: Record<string, number> = Object.fromEntries(arg('targets', 'tier1=48,tier2=43,tier3+=32,obvious-skip=27').split(',').map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const cap = Number(arg('cap', '6'));
const SEED = 'job-radar-gold-v2';
const h = (s: string) => crypto.createHash('sha1').update(SEED + s).digest('hex');
const db = openDb();
const rows = db.prepare('SELECT * FROM jobs WHERE tier IS NOT NULL').all() as any[];
const pass = rows.filter((r) => !r.filter_reason);
const skips = rows.filter((r) => r.filter_reason === 'no track keyword'); // location fine, no engineering/solutions title keyword
const pools: Record<string, any[]> = {
  tier1: pass.filter((r) => r.tier === 1), tier2: pass.filter((r) => r.tier === 2), 'tier3+': pass.filter((r) => r.tier >= 3), 'obvious-skip': skips,
};
const existing: any[] = fs.existsSync(P.candidates) ? fs.readFileSync(P.candidates, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const have = new Set(existing.map((e) => e.key));
const now = new Date().toISOString();
const added: any[] = [];
for (const [stratum, target] of Object.entries(targets)) {
  const cur = existing.filter((e) => e.stratum === stratum);
  const count: Record<string, number> = {};
  cur.forEach((e) => (count[e.snapshot.company] = (count[e.snapshot.company] ?? 0) + 1));
  let n = cur.length;
  for (const r of [...pools[stratum]].sort((x, y) => h(x.key).localeCompare(h(y.key)))) {
    if (n >= target) break;
    if (have.has(r.key) || (count[r.company] ?? 0) >= cap) continue;
    count[r.company] = (count[r.company] ?? 0) + 1; have.add(r.key); n++;
    added.push({ key: r.key, stratum, snapshot: { source: r.source, id: r.id, title: r.title, company: r.company, location: r.location, description: r.description, url: r.url, pay: r.pay, tier: r.tier, first_seen: r.first_seen, snapshot_at: now } });
  }
  if (n < target) console.warn(`stratum ${stratum}: only ${n}/${target} available`);
}
const all = [...existing, ...added];
fs.writeFileSync(P.candidates, all.map((c) => JSON.stringify(c)).join('\n') + '\n');
const dist: Record<string, number> = {};
all.forEach((c) => (dist[c.stratum] = (dist[c.stratum] ?? 0) + 1));
console.log(`candidates: ${existing.length} kept + ${added.length} added = ${all.length}`, dist, `unique=${new Set(all.map((c) => c.key)).size}`);
