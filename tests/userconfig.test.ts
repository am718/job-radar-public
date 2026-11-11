import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveUserFile, loadUserFile, loadCompanies, ConfigSchema, ROOT } from '../src/userconfig.js';
import { makeLocationTier } from '../src/location.js';
import { PROMPTS, buildPrompts, promptFacts } from '../src/scoring/prompts.js';
import { buildConfigFromAnswers, placePatterns } from '../src/cli/init.js';

const exCfg = () => ConfigSchema.parse(JSON.parse(fs.readFileSync('job-radar.config.example.json', 'utf8')));
const sha8 = (x: string) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 8);

describe('user files: env override -> real file -> committed example', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it('env override wins', () => {
    process.env.JOB_RADAR_CONFIG = 'tests/fixtures/config.test.json';
    expect(resolveUserFile('config')).toBe(path.resolve('tests/fixtures/config.test.json'));
  });
  it('without an override it is the real file when present, else the example', () => {
    delete process.env.JOB_RADAR_PROFILE; delete process.env.JOB_RADAR_COMPANIES; delete process.env.JOB_RADAR_CONFIG;
    for (const [n, real] of [['profile', 'profile.json'], ['companies', 'companies.json'], ['config', 'job-radar.config.json']] as const) {
      const want = fs.existsSync(path.join(ROOT, real)) ? real : real.replace('.json', '.example.json');
      expect(resolveUserFile(n)).toBe(path.join(ROOT, want));
    }
  });
  it('the test environment points at fixtures, never the owner files', () => {
    for (const n of ['profile', 'companies', 'config'] as const) expect(resolveUserFile(n)).toContain(path.join('tests', 'fixtures'));
    expect(loadCompanies().length).toBeGreaterThan(0);
    expect((loadUserFile<{ summary: string }>('profile')).summary.length).toBeGreaterThan(20);
  });
});

describe('committed examples are valid', () => {
  it('config example parses and classifies locations', () => {
    const t = makeLocationTier(exCfg().locationTiers);
    expect(t({ location: 'Chicago, IL' })).toBe(1);
    expect(t({ location: 'Remote - US' })).toBe(2);
    expect(t({ location: 'Remote - Canada' })).toBeNull();
    expect(t({ location: 'Austin, TX' })).toBe(3);
    expect(t({ location: 'Paris, France' })).toBeNull();
  });
  it('companies example: 10+ boards, known ATS, unique', () => {
    const cs = JSON.parse(fs.readFileSync('companies.example.json', 'utf8')) as { name: string; ats: string; slug: string }[];
    expect(cs.length).toBeGreaterThanOrEqual(10);
    for (const c of cs) expect(['greenhouse', 'lever', 'ashby', 'workable']).toContain(c.ats);
    expect(new Set(cs.map((c) => `${c.ats}:${c.slug}`)).size).toBe(cs.length);
  });
  it('profile example has the fields the prompts need', () => {
    const p = JSON.parse(fs.readFileSync('profile.example.json', 'utf8'));
    for (const k of ['name', 'summary', 'goal', 'graduation', 'experience_note']) expect(typeof p[k]).toBe('string');
  });
});

describe('prompts carry no personal facts', () => {
  it('prompts.ts source has no year or graduation text', () => {
    const src = fs.readFileSync('src/scoring/prompts.ts', 'utf8');
    expect(src).not.toMatch(/\b(19|20)\d\d\b/);
    expect(src).not.toMatch(/\bfreelance\b|\bfounder\b/i);
  });
  it('rendered from profile.example.json: facts come from the profile fields only', () => {
    const ex = JSON.parse(fs.readFileSync('profile.example.json', 'utf8'));
    const P = buildPrompts(promptFacts(ex));
    for (const id of Object.keys(P)) expect(P[id].system).not.toMatch(/\$\{|undefined/);
    expect(P.v4.system).toContain(`(the candidate graduates ${ex.graduation})`);
    expect(P.v4.system).toContain(`The candidate has real ${ex.experience_note},`);
    const other = buildPrompts(promptFacts({ graduation: 'Dec 2031', experience_note: 'lab research' }));
    expect(other.v3.system).toContain('Dec 2031'); expect(other.v3.system).not.toContain(ex.graduation);
    // personal text of whoever runs the tests (read from their own profile.json at run time, never stored here)
    if (fs.existsSync('profile.json')) {
      const real = JSON.parse(fs.readFileSync('profile.json', 'utf8'));
      if (real.graduation !== ex.graduation) for (const id of Object.keys(P)) expect(P[id].system).not.toContain(real.graduation);
      if (real.name && real.name !== ex.name) for (const id of Object.keys(P)) expect(P[id].system).not.toContain(real.name);
    }
    expect(Object.keys(PROMPTS)).toEqual(Object.keys(P));
  });
  // Score-cache guard: the owner's rendered prompts (and profile summary) must hash to what was cached. Hashes only, no text.
  const hasReal = fs.existsSync('profile.json');
  (hasReal ? it : it.skip)('the real profile.json renders byte-identical prompts (cached scores stay valid)', () => {
    const real = JSON.parse(fs.readFileSync('profile.json', 'utf8'));
    const P = buildPrompts(promptFacts(real));
    expect(Object.fromEntries(Object.keys(P).map((id) => [id, sha8(P[id].system)]))).toEqual({ v1: 'b204718e', v2: 'd950c084', v3: '12a3ee6c', v4: 'f09203b7' });
    expect(sha8(real.summary)).toBe('e220205f');
  });
});

describe('npm run init core', () => {
  const ans = { name: 'Sam Example', trackARoles: 'Software Engineer, Data Engineer', trackBRoles: '', locations: ['Chicago, IL', 'Evanston'], remoteOk: true, minBasePay: 90000, requiresSponsorship: false, graduation: 'May 2028' };
  it('builds a valid config and profile', () => {
    const { profile, config } = buildConfigFromAnswers(ans, exCfg());
    expect(() => ConfigSchema.parse(config)).not.toThrow();
    expect(config.minBasePay).toBe(90000); expect(config.requiresSponsorship).toBe(false);
    expect(config.trackAKeywords).toEqual(['software engineer', 'data engineer']);
    expect(config.trackBKeywords).toEqual(exCfg().trackBKeywords);
    expect(config.locationTiers.map((t) => t.tier)).toEqual([1, 2]);
    const t = makeLocationTier(config.locationTiers);
    expect(t({ location: 'Chicago, IL' })).toBe(1); expect(t({ location: 'Evanston, Illinois' })).toBe(1); expect(t({ location: 'Springfield, IL' })).toBe(1);
    expect(t({ location: 'Remote, United States' })).toBe(2); expect(t({ location: 'Boston, MA' })).toBeNull();
    expect(profile.name).toBe('Sam Example'); expect(profile.summary).toContain('Sam Example.'); expect(profile.graduation).toBe('May 2028');
    expect(profile.experience_note).toBeTruthy();
  });
  it('no locations and no remote is refused; no locations + remote makes remote tier 1', () => {
    expect(() => buildConfigFromAnswers({ ...ans, locations: [], remoteOk: false }, exCfg())).toThrow();
    const { config } = buildConfigFromAnswers({ ...ans, locations: [''], remoteOk: true }, exCfg());
    expect(config.locationTiers).toEqual([{ tier: 1, label: 'Remote (US)', patterns: [], remote: true }]);
  });
  it('place patterns escape regex characters', () => {
    expect(placePatterns(['St. Louis, MO'])).toEqual(['\\b(st\\. louis)\\b|,\\s*mo\\b']);
  });
});
