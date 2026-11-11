import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBamboohr, bamboohrBoardUrl } from '../src/adapters/bamboohr.js';
import { parsePersonio, personioBoardUrl } from '../src/adapters/personio.js';
import { parseTeamtailor, teamtailorBoardUrl } from '../src/adapters/teamtailor.js';
import { parseWorkday, workdayBoardUrl, WORKDAY_APPLY_BY_HAND } from '../src/adapters/workday.js';

const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), 'utf8');
const json = (p: string) => JSON.parse(fx(p));

describe('bamboohr', () => {
  it('parses list + detail', () => {
    const jobs = parseBamboohr(json('bamboohr/list.json'), 'Canopy', 'canopy', json('bamboohr/details.json'));
    expect(jobs).toHaveLength(2);
    const j = jobs.find((x) => x.id === '45')!;
    expect(j).toMatchObject({ source: 'bamboohr', company: 'Canopy', title: 'Sales Officer-FIP', location: 'Kingston, Jamaica', url: 'https://canopy.bamboohr.com/careers/45', postedAt: '2025-02-20T00:00:00.000Z', postedSource: 'published', payRaw: null });
    expect(j.description).toContain('Main Duties');
    expect(j.description).toContain('- Onboarding of employer groups');
    expect(j.description).not.toContain('<');
  });
  it('without detail: no description, no date', () => {
    const j = parseBamboohr(json('bamboohr/list.json'), 'Canopy', 'canopy')[0];
    expect(j).toMatchObject({ id: '42', title: 'ACCOUNT MANAGER 2', location: 'Kingston', description: '', postedAt: null, postedSource: null, url: 'https://canopy.bamboohr.com/careers/42' });
  });
  it('empty/garbage -> []', () => {
    for (const g of [null, undefined, {}, [], 'x', { result: 'no' }]) expect(parseBamboohr(g, 'C', 's')).toEqual([]);
    expect(bamboohrBoardUrl('canopy')).toBe('https://canopy.bamboohr.com/careers/list');
  });
});

describe('personio', () => {
  const jobs = parsePersonio(fx('personio/xml.xml'), '360T', '360t');
  it('parses positions', () => {
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source: 'personio', id: '2522036', company: '360T', title: 'BUSINESS CLIENT ADVISORY SERVICES MANAGER, AMERICAS', location: 'New York', url: 'https://360t.jobs.personio.de/job/2522036', postedAt: '2026-02-06T15:31:21.000Z', postedSource: 'created' });
    expect(jobs[0].description).toContain('Your Role');
    expect(jobs[0].description).not.toMatch(/<|CDATA/);
    expect(jobs[0].payRaw).toMatchObject({ min: 75000, max: 100000, interval: 'year', currency: 'USD' });
    expect(fx('personio/xml.xml')).not.toMatch(/careers@360t/);
  });
  it('remote office text', () => {
    expect(jobs[1].location).toBe('Cologne / Remote from Germany');
    expect(jobs[1].remote).toBe(true);
    expect(jobs[1].payRaw).toBeNull();
  });
  it('empty/garbage -> []', () => {
    for (const g of ['', 'garbage', '<workzag-jobs>\n\n</workzag-jobs>', null as any]) expect(parsePersonio(g, 'C', 's')).toEqual([]);
    expect(personioBoardUrl('x')).toBe('https://x.jobs.personio.de/xml');
  });
});

describe('teamtailor', () => {
  const jobs = parseTeamtailor(fx('teamtailor/jobs.rss'), 'Acme');
  it('parses items', () => {
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source: 'teamtailor', id: '005797eb-112d-4b12-9a36-70f437d103d8', company: 'Acme', title: 'Business Analyst II', url: 'https://empower.na.teamtailor.com/jobs/727147-business-analyst-ii', postedAt: '2026-10-27T15:28:34.000Z', postedSource: 'published', workplaceRaw: 'fully', remote: true });
    expect(jobs[0].location).toContain('Remote');
    expect(jobs[0].description).toContain('Competitive compensation');
    expect(jobs[0].description).not.toMatch(/<\w|&lt;/);
    expect(jobs[1].location).toContain('New York');
    expect(jobs[1].postedAt).toBe('2026-07-03T14:04:56.000Z');
  });
  it('empty/garbage -> []', () => {
    for (const g of ['', 'nope', '<rss><channel></channel></rss>', null as any]) expect(parseTeamtailor(g, 'C')).toEqual([]);
    expect(teamtailorBoardUrl('x')).toBe('https://x.teamtailor.com/jobs.rss');
  });
});

describe('workday', () => {
  const slug = 'nvidia|wd5|NVIDIAExternalCareerSite';
  it('parses list + details', () => {
    const jobs = parseWorkday(json('workday/list.json'), 'NVIDIA', slug, json('workday/details.json'));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source: 'workday', id: 'JR2020825', company: 'NVIDIA', title: 'Software Engineer, OpenShell', location: 'US, Remote', remote: true, url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-Remote/Software-Engineer--OpenShell_JR2020825', postedAt: '2026-10-30T00:00:00.000Z', postedSource: 'published' });
    expect(jobs[0].description.length).toBeGreaterThan(100);
    expect(jobs[0].description).not.toMatch(/<\w/);
  });
  it('without details: list-only job, no date', () => {
    const j = parseWorkday(json('workday/list.json'), 'NVIDIA', slug)[1];
    expect(j).toMatchObject({ id: 'JR2028458', location: 'US, CA, Santa Clara', description: '', postedAt: null, postedSource: null });
  });
  it('empty/garbage -> [] and constants', () => {
    for (const g of [null, {}, [], 'x', { jobPostings: 'no' }]) expect(parseWorkday(g, 'C', slug)).toEqual([]);
    expect(parseWorkday(json('workday/list.json'), 'C', 'bad-slug')).toEqual([]);
    expect(workdayBoardUrl(slug)).toBe('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite');
    expect(WORKDAY_APPLY_BY_HAND).toBe(true);
  });
});
