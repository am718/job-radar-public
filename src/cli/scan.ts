import 'dotenv/config';
import fs from 'node:fs';
import { openDb, recordFetch } from '../store.js';
import { fetchCompany } from '../adapters/index.js';
import { todayET, processJobs, pendingDigestRows, digestRowsFor, stillOpenRows, byHandEntries, buildDigest, type ScanStats } from '../pipeline.js';
import { usage, cacheVersion } from '../scoring/scorer.js';
import { budgetedLlm, summary, capWarning, loadLedger, spentFor } from '../spend.js';
import { estimateCost, printEstimate } from '../cost.js';
import { writeDigest } from '../digest.js';
import { writeDroppedFile } from '../dropped.js';
import { postedInfo, etDate } from '../fresh.js';
import type { Company, Job } from '../types.js';
import { loadCompanies } from '../userconfig.js';

// usage: npm run scan -- [--only Stripe,Plaid] [--yes]
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map((s) => s.toLowerCase()) : null;
const yes = args.includes('--yes');
const phase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : 'FEED';
const fetchOnly = args.includes('--fetch-only');
const freshOnly = args.includes('--fresh-only'); // quick daily run: score only jobs posted in the last 7 days or NEW today // store postings, never call the LLM
const OK_FILE = 'data/.cost_ok';

const dateOf = () => args.includes('--date') ? args[args.indexOf('--date') + 1] : new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
if (args.includes('--digest-only')) {   // rebuild a day's digest from stored scores: no fetch, no LLM
  const db0 = openDb(); let d0 = dateOf();
  if (!args.includes('--date') && !(db0.prepare('SELECT 1 FROM jobs WHERE digest_date=?').get(d0))) {   // nothing digested today yet: rebuild the most recent digest day
    const last = db0.prepare('SELECT max(digest_date) d FROM jobs').get() as { d: string | null }; if (last.d) { console.log(`no digest rows for ${d0}; rebuilding the latest digest day ${last.d} (freshness measured as of ${d0})`); }
    d0 = last.d ?? d0;
  }
  const rows0 = digestRowsFor(db0, d0, undefined, undefined, todayET());
  const dropped0 = writeDroppedFile(db0, d0);
  const so0 = stillOpenRows(db0, d0, undefined, undefined, todayET());
  console.log(rows0.length ? `digest written: ${writeDigest(buildDigest(rows0, d0, rows0.length, dropped0.count, so0, byHandEntries(db0, rows0, so0)), d0)} (${rows0.length} stored scores, 0 API calls); ${dropped0.count} dropped-for-pay listed in ${dropped0.path}` : `no stored digest rows for ${d0}`);
  process.exit(0);
}
const companies: Company[] = loadCompanies().filter((c: Company) => !only || only.includes(c.name.toLowerCase()));
const db = openDb();
const stats: ScanStats = { fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] };

const seenAt = new Date().toISOString();
const perCompany: Record<string, Job[]> = {};
for (const c of companies) {
  try { perCompany[c.name] = await fetchCompany(c); console.log(`${c.name} (${c.ats}): ${perCompany[c.name].length} postings`); recordFetch(db, c.name, perCompany[c.name].length, seenAt); }
  catch (e) { stats.errors.push(`${c.name}: ${(e as Error).message}`); }
}
// Public job feeds (HN Who is hiring, RemoteOK, We Work Remotely, USAJobs, Adzuna): on with --feeds, or by default once feeds.json exists (copy feeds.example.json).
// They are not one company's board, so no company_fetch row is recorded for them (that table drives "still open").
if (args.includes('--feeds') || (!only && !args.includes('--no-feeds') && fs.existsSync('feeds.json'))) {
  const { loadFeedConfig, fetchFeeds } = await import('../feeds/index.js');
  for (const f of await fetchFeeds(loadFeedConfig())) {
    if (f.skipped) console.log(`feed ${f.source}: skipped (${f.skipped})`);
    else if (f.error) stats.errors.push(`feed ${f.source}: ${f.error}`);
    else { perCompany[`feed:${f.source}`] = f.jobs; console.log(`feed ${f.source}: ${f.jobs.length} postings`); }
  }
}
// Stage 1: store without scoring so we can estimate cost first
await processJobs(db, Object.values(perCompany).flat(), null, { ...stats, errors: [] }, undefined, undefined, { seenAt });
stats.fetched = Object.values(perCompany).flat().length;

const todayStr = todayET();
const newToday = (db.prepare("SELECT first_seen FROM jobs WHERE is_baseline=0").all() as { first_seen: string }[]).filter((r) => etDate(r.first_seen) === todayStr).length;
console.log(`NEW today (first seen today, not part of any first-time company scan): ${newToday}`);
if (fetchOnly) { console.log(`fetch-only: stored postings, no LLM calls. total in db: ${(db.prepare('SELECT count(*) c FROM jobs').get() as any).c}`); process.exit(0); }
let pending = db.prepare(`SELECT length(description) AS n, posted_at, posted_at_source, first_seen, is_baseline FROM jobs WHERE filter_reason IS NULL AND status='new' AND key NOT IN (SELECT key FROM scores WHERE prompt_version=?)`).all(cacheVersion('v3')) as any[];
if (freshOnly) pending = pending.filter((r) => { const p = postedInfo(r, todayStr); return p.fresh || p.newToday; });
if (pending.length) {
  const est = estimateCost(pending.map((p) => p.n));
  printEstimate('scan scoring', est);
  { const w = capWarning(phase); if (w) console.log(w);
    const l = loadLedger(), left = l.phases[phase].cap_usd - spentFor(l, phase);
    if (est.usd != null && est.usd > left) console.log(`!! WARNING: this scan is estimated at $${est.usd.toFixed(2)} but only $${left.toFixed(2)} is left under the ${phase} cap; scoring will stop at the cap and the rest stays unscored.`); }
  const maxUsd = args.includes('--max-usd') ? Number(args[args.indexOf('--max-usd') + 1]) : Infinity;
  if (est.usd != null && est.usd > maxUsd) { console.log(`Estimate exceeds --max-usd ${maxUsd}; aborting before any LLM call.`); process.exit(0); }
  if (!yes && !fs.existsSync(OK_FILE)) {
    console.log('Approval required before the first scoring run. Re-run with --yes to approve (writes data/.cost_ok).');
    process.exit(0);
  }
  if (yes) fs.writeFileSync(OK_FILE, new Date().toISOString());
  const llm = budgetedLlm(phase, 'scan');
  await processJobs(db, [], llm, stats, undefined, undefined, { freshOnly });
}
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const fresh = pendingDigestRows(db);
if (fresh.length) {
  db.prepare(`UPDATE jobs SET status='seen', digest_date=? WHERE key IN (${fresh.map(() => '?').join(',')})`).run(date, ...fresh.map((r) => r.key));
}
const rows = digestRowsFor(db, date);
if (fresh.length || args.includes('--rebuild-digest')) {
  const dropped = writeDroppedFile(db, date);
  const so1 = stillOpenRows(db, date);
  const p = writeDigest(buildDigest(rows, date, rows.length, dropped.count, so1, byHandEntries(db, rows, so1)), date);
  console.log(`digest written: ${p} (${fresh.length} newly scored this run, ${rows.length} total for ${date})`);
} else console.log('no new scored jobs; digest unchanged');
console.log(`fetched=${stats.fetched} newStored=${(db.prepare('SELECT count(*) c FROM jobs').get() as any).c} scoredThisRun=${stats.scored} llmCalls=${stats.llmCalls}`);
const pin = Number(process.env.PRICE_IN_PER_MTOK), pout = Number(process.env.PRICE_OUT_PER_MTOK);
console.log(`usage: apiCalls=${usage.calls} inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} cost=$${((usage.inputTokens * pin + usage.outputTokens * pout) / 1e6).toFixed(4)} invalidOutputs=${usage.invalid} retries=${usage.retries}`);
console.log(summary(phase));
{ const w = capWarning(phase); if (w) console.log(w); }
if (stats.errors.some((e) => /budget cap/.test(e))) console.log(`!! SCAN STOPPED EARLY by the spend cap: ${stats.errors.filter((e) => /budget cap/.test(e)).length} job(s) were left unscored. They stay pending and will be scored on the next scan once budget is available.`);
if (stats.errors.length) console.log('errors:\n' + stats.errors.map((e) => '  ' + e).join('\n'));
