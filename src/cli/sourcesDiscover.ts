import fs from 'node:fs';
import type { BoardAts, Company, Job } from '../types.js';
import { greenhouseUrl, parseGreenhouse } from '../adapters/greenhouse.js';
import { leverUrl, parseLever } from '../adapters/lever.js';
import { ashbyUrl, parseAshby } from '../adapters/ashby.js';
import { workableBoardUrl, parseWorkable } from '../adapters/workable.js';
import { recruiteeBoardUrl, parseRecruitee } from '../adapters/recruitee.js';
import { breezyBoardUrl, parseBreezy } from '../adapters/breezy.js';
import { bamboohrBoardUrl, parseBamboohr } from '../adapters/bamboohr.js';
import { personioBoardUrl, parsePersonio } from '../adapters/personio.js';
import { teamtailorBoardUrl, parseTeamtailor } from '../adapters/teamtailor.js';
import { USER_AGENT } from '../config.js';
import { loadCompanies } from '../userconfig.js';

// usage: npm run sources:discover -- "Company Name" ["Other Co" ...] [--add]
// Tests each company name against every board ATS's public LIST endpoint (one read-only GET per ATS per slug guess, 1 s apart per host) and prints what exists.
// --add appends the boards it found to companies.json (which stays editable by hand). Workday needs a tenant|wdN|site slug and SmartRecruiters' API
// disallows crawlers in robots.txt, so neither is guessed; add Workday boards by hand.
type Probe = { ats: BoardAts; url: (slug: string) => string; count: (body: string, slug: string) => number };
const J = (f: (j: any, c: string, slug: string) => Job[]) => (body: string, slug: string) => { try { return f(JSON.parse(body), 'x', slug).length; } catch { return 0; } };
export const PROBES: Probe[] = [
  { ats: 'greenhouse', url: greenhouseUrl, count: J((j, c) => parseGreenhouse(j, c)) },
  { ats: 'lever', url: leverUrl, count: J((j, c) => parseLever(j, c)) },
  { ats: 'ashby', url: ashbyUrl, count: J((j, c) => parseAshby(j, c)) },
  { ats: 'workable', url: workableBoardUrl, count: J((j, c) => parseWorkable(j, c)) },
  { ats: 'recruitee', url: recruiteeBoardUrl, count: J((j, c) => parseRecruitee(j, c)) },
  { ats: 'breezy', url: breezyBoardUrl, count: J((j, c) => parseBreezy(j, c)) },
  { ats: 'bamboohr', url: bamboohrBoardUrl, count: J((j, c, s) => parseBamboohr(j, c, s)) },
  { ats: 'personio', url: personioBoardUrl, count: (b, s) => parsePersonio(b, 'x', s).length },
  { ats: 'teamtailor', url: teamtailorBoardUrl, count: (b) => parseTeamtailor(b, 'x').length },
];

/** Slug guesses for a company name: "Acme Health, Inc." -> acmehealth, acme-health, acme. Only [a-z0-9-] (a slug becomes part of a hostname for some ATSs). */
export function slugGuesses(name: string): string[] {
  const words = name.toLowerCase().replace(/[,.]?\s+(inc|llc|ltd|corp|co|gmbh|plc)\.?$/i, '').replace(/&/g, ' and ').replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(Boolean);
  return [...new Set([words.join(''), words.join('-'), words[0]].filter((s) => s && /^[a-z0-9-]{2,60}$/.test(s)))];
}

export type GetFn = (url: string) => Promise<{ status: number; body: string; finalUrl: string }>;
const lastHit = new Map<string, number>();
const defaultGet: GetFn = async (url) => {
  const h = new URL(url).host, wait = (lastHit.get(h) ?? 0) + 1000 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastHit.set(h, Date.now());
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });   // a redirect (e.g. BambooHR's unknown tenant -> home page) is "not found", never followed
  return { status: r.status, body: r.status === 200 ? (await r.text()).slice(0, 5_000_000) : '', finalUrl: url };
};

export async function discover(name: string, get: GetFn = defaultGet): Promise<{ ats: BoardAts; slug: string; postings: number }[]> {
  const found: { ats: BoardAts; slug: string; postings: number }[] = [];
  for (const p of PROBES) for (const slug of slugGuesses(name)) {
    try { const r = await get(p.url(slug)); if (r.status !== 200) continue; const n = p.count(r.body, slug); if (n > 0) { found.push({ ats: p.ats, slug, postings: n }); break; } } catch { /* unreachable: not found */ }
  }
  return found;
}

if (process.argv[1]?.endsWith('sourcesDiscover.ts')) {
  const args = process.argv.slice(2), add = args.includes('--add'), names = args.filter((a) => !a.startsWith('--'));
  if (!names.length) { console.error('usage: npm run sources:discover -- "Company Name" ["Other Co" ...] [--add]'); process.exit(1); }
  const companies: Company[] = loadCompanies();   // env override -> companies.json -> companies.example.json
  for (const name of names) {
    const hits = await discover(name);
    if (!hits.length) { console.log(`${name}: no public board found (guessed slugs: ${slugGuesses(name).join(', ')}). Workday boards must be added by hand as tenant|wdN|site.`); continue; }
    for (const h of hits) {
      const have = companies.some((c) => c.ats === h.ats && c.slug === h.slug);
      console.log(`${name}: ${h.ats}:${h.slug}  ${h.postings} postings${have ? '  (already in companies.json)' : add ? '  -> added' : ''}`);
      if (add && !have) companies.push({ name, ats: h.ats, slug: h.slug, tags: [] });
    }
  }
  if (add) { fs.writeFileSync('companies.json', JSON.stringify(companies, null, 2) + '\n'); console.log('companies.json updated'); }
}
