import 'dotenv/config';
import fs from 'node:fs';
import { openDb } from '../store.js';
import { allSites, getSite, isExpired, knownProtected, recordSite, siteStatus } from './sites.js';
import { preflightCompanies } from './preflight.js';
import { loadCompanies } from '../userconfig.js';
import { digestRowsFor, stillOpenRows, todayET } from '../pipeline.js';

const USAGE = 'usage: npm run sites                                  print the apply_sites table\n       npm run sites -- mark <company> protected|ok     correct a company by hand (stays until you change it)\n       npm run sites -- preflight [--force] [--date YYYY-MM-DD]   read-only GET of one apply page per digest company, then print the table';
const a = process.argv.slice(2);
const db = openDb();

function table(rows: { company: string; ats: string; status: string; vendor: string; note: string }[]) {
  const w = (k: keyof (typeof rows)[0], h: string) => Math.max(h.length, ...rows.map((r) => String(r[k]).length));
  const W = { company: w('company', 'company'), ats: w('ats', 'ATS'), status: w('status', 'status'), vendor: w('vendor', 'vendor') };
  const line = (r: (typeof rows)[0]) => `${r.company.padEnd(W.company)}  ${r.ats.padEnd(W.ats)}  ${r.status.padEnd(W.status)}  ${r.vendor.padEnd(W.vendor)}  ${r.note}`;
  console.log(line({ company: 'company', ats: 'ATS', status: 'status', vendor: 'vendor', note: 'checked / source / reason' }));
  rows.forEach((r) => console.log(line(r)));
}
function show() {
  const rows = allSites(db).map((s) => ({ company: s.company, ats: s.ats ?? '-', status: s.status, vendor: s.vendor ?? '-', note: `${s.checked_at.slice(0, 10)}${isExpired(s) ? ' EXPIRED' : ''} / ${s.source}${s.reason ? ` / ${s.reason.slice(0, 90)}` : ''}` }));
  for (const k of knownProtected()) if (!rows.some((r) => r.company.toLowerCase() === k.company.toLowerCase())) rows.push({ company: k.company, ats: k.ats ?? '-', status: 'protected', vendor: k.vendor ?? '-', note: `known-protected.json / ${k.reason?.slice(0, 90) ?? ''}` });
  if (!rows.length) console.log('(apply_sites is empty; run: npm run sites -- preflight)'); else table(rows);
}

const [cmd, ...rest] = a;
if (!cmd) show();
else if (cmd === 'mark') {
  const [company, to] = rest;
  if (!company || !['protected', 'ok'].includes(to)) { console.error(USAGE); process.exit(1); }
  const known = db.prepare('SELECT 1 FROM jobs WHERE lower(company)=lower(?) LIMIT 1').get(company) || getSite(db, company);
  if (!known) { console.error(`no company named "${company}" in the job database or apply_sites. Names are matched ignoring case; check the spelling (quote names with spaces).`); process.exit(1); }
  const real = (db.prepare('SELECT company FROM jobs WHERE lower(company)=lower(?) LIMIT 1').get(company) as { company: string } | undefined)?.company ?? getSite(db, company)!.company;
  const ats = (db.prepare('SELECT source FROM jobs WHERE company=? LIMIT 1').get(real) as { source: string } | undefined)?.source ?? null;
  recordSite(db, { company: real, ats, status: to as 'ok' | 'protected', vendor: to === 'protected' ? 'marked by hand' : null, reason: `marked ${to} by hand`, source: 'manual' });
  console.log(`${real}: marked ${to} (manual; does not expire). Effective status now: ${siteStatus(db, real).status}`);
} else if (cmd === 'preflight') {
  const di = rest.indexOf('--date');
  let day = di >= 0 ? rest[di + 1] : todayET();
  if (!(db.prepare('SELECT 1 FROM jobs WHERE digest_date=?').get(day))) { const last = db.prepare('SELECT max(digest_date) d FROM jobs').get() as { d: string | null }; if (last.d) day = last.d; }
  const rows = [...digestRowsFor(db, day, undefined, undefined, todayET()), ...stillOpenRows(db, day, undefined, undefined, todayET())];
  const jobs = rows.map((r) => { const j = db.prepare('SELECT source,id,url,company FROM jobs WHERE key=?').get(r.key) as any; return j; }).filter(Boolean);
  const slugOf = (c: string) => { try { return (loadCompanies()).find((x) => x.ats === 'greenhouse' && x.name === c)?.slug ?? null; } catch { return null; } };
  console.log(`digest ${day}: ${new Set(jobs.map((j: any) => j.company)).size} companies; one read-only GET each (plus robots.txt), 1 request/second/host\n`);
  const res = await preflightCompanies(db, jobs, { force: rest.includes('--force'), slugOf, log: (s) => console.error(`  ${s}`) });
  table(res.map((r) => { const st = siteStatus(db, r.company); return { company: r.company, ats: r.ats, status: st.status === 'protected' ? 'protected' : st.status, vendor: st.vendor ?? '-', note: r.cached ? `(cached ${st.source})` : r.result?.reason.slice(0, 90) ?? '' }; }).sort((x, y) => x.status.localeCompare(y.status) || x.company.localeCompare(y.company)));
} else { console.error(USAGE); process.exit(1); }
