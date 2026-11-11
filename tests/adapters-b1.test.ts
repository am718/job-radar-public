import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseWorkable, workableBoardUrl } from '../src/adapters/workable.js';
import { parseRecruitee, recruiteeBoardUrl } from '../src/adapters/recruitee.js';
import { parseBreezy, parseBreezyDetail, breezyBoardUrl } from '../src/adapters/breezy.js';
import { parseSmartRecruiters, parseSmartRecruitersDetail, smartrecruitersBoardUrl, fetchSmartRecruiters } from '../src/adapters/smartrecruiters.js';

const fx = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), 'utf8');
const json = (p: string) => JSON.parse(fx(p));
const noTags = (s: string) => expect(s).not.toMatch(/<[a-z/][^>]*>|&amp;|&nbsp;/i);

describe('workable', () => {
  const jobs = parseWorkable(json('workable/seeq.json'), 'Seeq');
  it('maps fields', () => {
    expect(jobs).toHaveLength(2);
    const j = jobs[0];
    expect(j.source).toBe('workable');
    expect(j.id).toBe('1B6E0A1710');
    expect(j.title).toBe('AI Software Engineer - Staff/Principal');
    expect(j.company).toBe('Seeq');
    expect(j.url).toBe('https://apply.workable.com/j/1B6E0A1710');
    expect(j.location).toContain('Remote');
    expect(j.location).toContain('United States');
    expect(j.postedAt).toBe('2026-09-21T00:00:00.000Z');
    expect(j.postedSource).toBe('published');
    expect(j.workplaceRaw).toBe('remote');
    expect(j.remote).toBe(true);
    expect(j.payRaw).toBeNull();
    expect(j.description.length).toBeGreaterThan(100);
    noTags(j.description);
  });
  it('non-telecommuting job is not remote', () => {
    const j = parseWorkable({ jobs: [{ shortcode: 'X', title: 'T', telecommuting: false, created_at: '2026-01-02', city: 'NYC', country: 'US', url: 'u' }] }, 'C')[0];
    expect(j.remote).toBeUndefined(); expect(j.workplaceRaw).toBeNull(); expect(j.postedSource).toBe('created');
  });
  it('url + empty/garbage', () => {
    expect(workableBoardUrl('seeq')).toContain('/widget/accounts/seeq');
    for (const g of [null, undefined, {}, [], 'x', 5, { jobs: 'x' }]) expect(parseWorkable(g, 'C')).toEqual([]);
  });
});

describe('recruitee', () => {
  const jobs = parseRecruitee(json('recruitee/offers.json'), 'CDI');
  it('maps fields', () => {
    expect(jobs).toHaveLength(2);
    const j = jobs[0];
    expect(j.source).toBe('recruitee');
    expect(j.id).toBe('2782614');
    expect(j.title).toBe('Software Engineer (Early Career)');
    expect(j.company).toBe('CDI');
    expect(j.url).toContain('software-engineer-early-career');
    expect(j.location).toMatch(/^Remote \| New York/);
    expect(j.postedAt).toBe('2026-10-13T17:35:33.000Z');
    expect(j.postedSource).toBe('published');
    expect(j.workplaceRaw).toBe('remote');
    expect(j.remote).toBe(true);
    expect(j.payRaw).toMatchObject({ min: 72000, max: 82000, interval: 'year', currency: 'USD' });
    expect(j.description.length).toBeGreaterThan(100);
    noTags(j.description);
  });
  it('hybrid/onsite/no salary', () => {
    const base = { id: 1, title: 'T', status: 'published', created_at: '2026-01-02 03:04:05 UTC', salary: { min: null, max: null, period: null, currency: null } };
    const h = parseRecruitee({ offers: [{ ...base, hybrid: true, remote: false }, { ...base, id: 2, on_site: true }] }, 'C');
    expect(h[0].workplaceRaw).toBe('hybrid'); expect(h[0].remote).toBeUndefined(); expect(h[0].payRaw).toBeNull();
    expect(h[1].workplaceRaw).toBe('onsite'); expect(h[1].postedSource).toBe('created');
  });
  it('url + empty/garbage', () => {
    expect(recruiteeBoardUrl('acme')).toBe('https://acme.recruitee.com/api/offers/');
    for (const g of [null, undefined, {}, [], 'x', { offers: 3 }]) expect(parseRecruitee(g, 'C')).toEqual([]);
  });
});

describe('breezy', () => {
  const list = json('breezy/list.json');
  const detail = parseBreezyDetail(fx('breezy/detail-026d43128c81.html'));
  it('detail parsed from JSON-LD', () => {
    expect(detail).not.toBeNull();
    expect(detail!.description).toContain('golang');
    noTags(detail!.description);
    expect(detail!.payRaw).toMatchObject({ min: 80000, max: 130000, interval: 'year', currency: 'USD' });
  });
  it('maps fields', () => {
    const jobs = parseBreezy(list, 'Tristero', { '026d43128c81': detail });
    expect(jobs).toHaveLength(3);
    const j = jobs.find((x) => x.id === '026d43128c81')!;
    expect(j.source).toBe('breezy');
    expect(j.title).toBe('Junior Software Engineer');
    expect(j.company).toBe('Tristero');
    expect(j.url).toBe('https://tristero.breezy.hr/p/026d43128c81-junior-software-engineer');
    expect(j.location).toContain('NYC');
    expect(j.postedAt).toBe('2023-12-08T16:23:34.743Z');   // list published_date, not JSON-LD datePosted
    expect(j.postedSource).toBe('published');
    expect(j.workplaceRaw).toBeNull();
    expect(j.description).toContain('golang');
    expect(j.payRaw?.min).toBe(80000);
    const u = jobs[0];
    expect(u.workplaceRaw).toBe('remote'); expect(u.remote).toBe(true); expect(u.description).toBe(''); expect(u.payRaw).toBeNull();
  });
  it('url + empty/garbage', () => {
    expect(breezyBoardUrl('acme')).toBe('https://acme.breezy.hr/json');
    for (const g of [null, undefined, {}, 'x', 7, [null, {}]]) expect(parseBreezy(g, 'C')).toEqual([]);
    expect(parseBreezyDetail('<html>nothing</html>')).toBeNull();
    expect(parseBreezyDetail(undefined as any)).toBeNull();
  });
});

describe('smartrecruiters (synthetic fixture; API disallowed by robots.txt)', () => {
  const detail = parseSmartRecruitersDetail(json('smartrecruiters/synthetic-detail.json'));
  const jobs = parseSmartRecruiters(json('smartrecruiters/synthetic-list.json'), 'ExampleCo', { '743999000000001': detail });
  it('maps fields', () => {
    expect(jobs).toHaveLength(2);
    const j = jobs[0];
    expect(j.source).toBe('smartrecruiters');
    expect(j.id).toBe('743999000000001');
    expect(j.title).toBe('Senior Backend Engineer');
    expect(j.location).toBe('New York, NY, United States');
    expect(j.url).toContain('jobs.smartrecruiters.com/ExampleCo/743999000000001');
    expect(j.postedAt).toBe('2026-10-01T14:30:00.000Z');
    expect(j.postedSource).toBe('published');
    expect(j.description).toContain('Build services in Go.');
    expect(j.description).toContain('- Own APIs');
    noTags(j.description);
    expect(j.workplaceRaw).toBeNull();
    expect(jobs[1].remote).toBe(true); expect(jobs[1].workplaceRaw).toBe('remote'); expect(jobs[1].location).toContain('Remote');
  });
  it('url + empty/garbage + disabled fetch', async () => {
    expect(smartrecruitersBoardUrl('x')).toContain('/v1/companies/x/postings');
    for (const g of [null, undefined, {}, [], 'x', { content: 1 }]) expect(parseSmartRecruiters(g, 'C')).toEqual([]);
    expect(parseSmartRecruitersDetail(null)).toBeNull();
    await expect(fetchSmartRecruiters('x', 'C')).rejects.toThrow(/smartrecruiters x: HTTP 403/);
  });
});
