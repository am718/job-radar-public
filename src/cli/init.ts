import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ROOT, ConfigSchema, type UserConfig, type Profile } from '../userconfig.js';

// npm run init: asks a few questions, writes profile.json and job-radar.config.json (both gitignored). --force overwrites existing files.

export interface InitAnswers {
  name: string;
  /** Free text, comma separated, e.g. "software engineer, backend engineer". */
  trackARoles: string;
  trackBRoles: string;
  /** Free text places, e.g. ["Chicago, IL", "Evanston"]. Becomes tier 1. */
  locations: string[];
  remoteOk: boolean;
  minBasePay: number;
  requiresSponsorship: boolean | null;
  graduation?: string;
  experienceNote?: string;
}

const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unique = <T>(a: T[]) => [...new Set(a)];

/** Regex sources for one tier from place names: "Chicago, IL" -> city \bchicago\b and state ,\s*il\b. */
export function placePatterns(places: string[]): string[] {
  const cities: string[] = [], states: string[] = [];
  for (const p of places) {
    const [city, st] = p.split(',').map((x) => x.trim()).filter(Boolean);
    if (city) cities.push(esc(city.toLowerCase()));
    if (st && /^[a-z]{2}$/i.test(st)) states.push(st.toLowerCase());
  }
  const out: string[] = [];
  if (cities.length) out.push(`\\b(${unique(cities).join('|')})\\b`);
  for (const s of unique(states)) out.push(`,\\s*${s}\\b`);
  return out.length ? [out.join('|')] : [];
}

export function loadExampleConfig(): UserConfig {
  return ConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, 'job-radar.config.example.json'), 'utf8')));
}

/** Pure: the answers become a profile and a config. Everything not asked comes from the example config. */
export function buildConfigFromAnswers(ans: InitAnswers, base: UserConfig = loadExampleConfig()): { profile: Profile; config: UserConfig } {
  const a = list(ans.trackARoles), b = list(ans.trackBRoles);
  const places = ans.locations.map((l) => l.trim()).filter(Boolean);
  const tiers: UserConfig['locationTiers'] = [];
  if (places.length) tiers.push({ tier: 1, label: places.join(' / '), patterns: placePatterns(places) });
  if (ans.remoteOk) tiers.push({ tier: tiers.length + 1, label: 'Remote (US)', patterns: [], remote: true });
  if (!tiers.length) throw new Error('give at least one location or allow remote');
  const config: UserConfig = {
    ...base,
    minBasePay: ans.minBasePay,
    requiresSponsorship: ans.requiresSponsorship,
    trackAKeywords: a.length ? a : base.trackAKeywords,
    trackBKeywords: b.length ? b : base.trackBKeywords,
    locationTiers: tiers,
    listedPayRequired: [],
  };
  const where = [...places, ...(ans.remoteOk ? ['Remote (US)'] : [])].join(', ');
  const name = ans.name.trim();
  const summary = [
    `${name}. Seeking entry-level full-time roles.`,
    `Track A: ${a.join(', ') || 'software engineering'}. Track B: ${b.join(', ') || 'solutions engineering'}.`,
    `Location preference: ${where}.`,
    'Skills: EDIT ME (languages, frameworks, tools).',
    'Experience: EDIT ME (internships, projects, work; facts only, the scorer and cover letters may not invent anything).',
    'Not a fit: roles requiring 3+ years, senior or lead titles, roles needing security clearance or a PhD.',
  ].join('\n');
  const profile: Profile = {
    name, summary, resume_A: 'Engineering resume (Track A)', resume_B: 'Solutions / business resume (Track B)',
    goal: `I want a role with base pay of at least $${ans.minBasePay.toLocaleString('en-US')}${ans.remoteOk ? ', remote or near ' + (places[0] ?? 'home') : ' near ' + (places[0] ?? 'home')}. (Used by the scanner's code rules; not sent to the scorer.)`,
    graduation: ans.graduation?.trim() || 'soon',
    experience_note: ans.experienceNote?.trim() || 'project experience',
    _note: "Only 'summary' is sent to the scorer (and hashed into the score cache key). 'goal' is for the code rules. 'graduation' and 'experience_note' are rendered into the scoring prompts.",
  };
  return { profile, config };
}

const yes = (s: string, dflt: boolean) => (s.trim() === '' ? dflt : /^y/i.test(s.trim()));

async function main() {
  const force = process.argv.includes('--force');
  const targets = { profile: path.join(ROOT, 'profile.json'), config: path.join(ROOT, 'job-radar.config.json') };
  const existing = Object.values(targets).filter((f) => fs.existsSync(f));
  if (existing.length && !force) {
    console.error(`Refusing to overwrite: ${existing.map((f) => path.basename(f)).join(', ')} already exist(s). Re-run with --force to replace.`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = (await rl.question('Your full name: ')).trim();
    if (!name) throw new Error('a name is required');
    const trackARoles = await rl.question('Track A target roles (engineering-heavy), comma separated [software engineer, backend engineer]: ');
    const trackBRoles = await rl.question('Track B target roles (customer-facing technical), comma separated [solutions engineer, implementation]: ');
    const locations = (await rl.question('Location(s) you would work from or commute to, comma separated pairs like "Chicago, IL; Evanston, IL" (semicolon between places; blank for none): ')).split(';');
    const remoteOk = yes(await rl.question('Is remote (US) OK? [Y/n]: '), true);
    const pay = Number((await rl.question('Minimum annual BASE pay in USD [95000]: ')).replace(/[^0-9.]/g, '') || '95000');
    if (!Number.isFinite(pay) || pay <= 0) throw new Error('pay floor must be a number');
    const sp = (await rl.question('Do you need visa sponsorship? [y/n/skip]: ')).trim().toLowerCase();
    const graduation = await rl.question('Graduation (e.g. "June 2027", blank to skip): ');
    const { profile, config } = buildConfigFromAnswers({
      name, trackARoles, trackBRoles, locations, remoteOk, minBasePay: pay,
      requiresSponsorship: sp.startsWith('y') ? true : sp.startsWith('n') ? false : null, graduation,
    });
    fs.writeFileSync(targets.profile, JSON.stringify(profile, null, 2) + '\n');
    fs.writeFileSync(targets.config, JSON.stringify(config, null, 2) + '\n');
    console.log(`\nWrote profile.json and job-radar.config.json (both gitignored).\n\nNext steps:
  1. Edit profile.json: replace the EDIT ME lines in "summary" with your real skills and experience (facts only).
  2. cp answers.example.json answers.json and fill it in (name, email, links, standing answers).
  3. Put your resumes in resumes/ (see "resumes" in answers.json).
  4. Add companies: companies.example.json is used until you create companies.json; use "npm run discover -- greenhouse:stripe" to add boards.
  5. Put ANTHROPIC_API_KEY in .env (see .env.example), then run "npm run scan".`);
  } finally { rl.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
