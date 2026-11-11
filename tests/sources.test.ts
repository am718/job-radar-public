import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { slugGuesses, discover, PROBES } from '../src/cli/sourcesDiscover.js';
import { BOARD_FETCHERS } from '../src/adapters/index.js';
import { parseWorkdaySlug } from '../src/adapters/workday.js';
import { isFillable, FILLABLE } from '../src/types.js';

describe('sources:discover', () => {
  it('guesses only hostname-safe slugs', () => {
    expect(slugGuesses('Acme Health, Inc.')).toEqual(['acmehealth', 'acme-health', 'acme']);
    expect(slugGuesses('Ben & Jerry\'s')).toEqual(['benandjerrys', 'ben-and-jerrys', 'ben']);
    for (const s of slugGuesses('evil.com/x?y Corp')) expect(s).toMatch(/^[a-z0-9-]+$/);
  });
  it('probes every board ATS with one GET per slug guess and reports only boards with postings (no network)', async () => {
    const seen: string[] = [];
    const get = async (url: string) => { seen.push(url); return url.includes('recruitee.com') && url.includes('acmehealth') ? { status: 200, body: fs.readFileSync('fixtures/recruitee/offers.json', 'utf8'), finalUrl: url } : { status: 404, body: '', finalUrl: url }; };
    const hits = await discover('Acme Health', get);
    expect(hits).toEqual([{ ats: 'recruitee', slug: 'acmehealth', postings: expect.any(Number) }]); expect(hits[0].postings).toBeGreaterThan(0);
    expect(new Set(seen.map((u) => new URL(u).host.split('.').slice(-2).join('.'))).size).toBeGreaterThanOrEqual(8);
    expect(seen.some((u) => /smartrecruiters|myworkdayjobs|linkedin|indeed|handshake/.test(u))).toBe(false);   // never guessed: robots-disallowed / needs a hand-entered slug / forbidden
    expect(PROBES.map((p) => p.ats).sort()).toEqual(['ashby', 'bamboohr', 'breezy', 'greenhouse', 'lever', 'personio', 'recruitee', 'teamtailor', 'workable']);
  });
});
describe('board registry', () => {
  it('has a fetcher for every board ATS; only greenhouse/lever/ashby are fillable', () => {
    expect(Object.keys(BOARD_FETCHERS).sort()).toEqual(['ashby', 'bamboohr', 'breezy', 'greenhouse', 'lever', 'personio', 'recruitee', 'smartrecruiters', 'teamtailor', 'workable', 'workday']);
    expect([...FILLABLE]).toEqual(['greenhouse', 'lever', 'ashby']); expect(isFillable('workday')).toBe(false); expect(isFillable('alert')).toBe(false);
  });
  it('a Workday slug can only become a myworkdayjobs.com hostname', () => {
    expect(parseWorkdaySlug('nvidia|wd5|NVIDIAExternalCareerSite')).toEqual({ tenant: 'nvidia', wd: 'wd5', site: 'NVIDIAExternalCareerSite' });
    for (const bad of ['evil.com#|wd5|x', 'a|wd5|../x', 'a|evil.com|x', 'a@b|wd1|x']) expect(() => parseWorkdaySlug(bad)).toThrow();
  });
});
