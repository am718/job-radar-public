import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { detectArrangement, detectFromText, hoursNote, arrangementAdj, isLowOffice } from '../src/arrangement.js';
import { rankScore } from '../src/rank.js';
import { parseGreenhouse, greenhouseWorkplace } from '../src/adapters/greenhouse.js';
import { parseLever } from '../src/adapters/lever.js';
import { parseAshby } from '../src/adapters/ashby.js';
import { openDb } from '../src/store.js';
import { processJobs, type ScanStats } from '../src/pipeline.js';
import { buildDigest } from '../src/digest.js';
import { cacheVersion, loadProfile } from '../src/scoring/scorer.js';
import { payFromText } from '../src/pay.js';
import type { Job } from '../src/types.js';

const d = (description: string, extra: object = {}) => detectArrangement({ description, location: 'New York, NY', ...extra });
const fx = (n: string) => JSON.parse(fs.readFileSync(`fixtures/${n}.json`, 'utf8'));
const mk = (o: Partial<Job> = {}): Job => ({ source: 'ashby', id: '1', company: 'Acme', title: 'Software Engineer', location: 'New York, NY', description: 'Build things.', url: 'https://x/1', ...o });
const stats = (): ScanStats => ({ fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] });
const goodJson = JSON.stringify({ score: 80, track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' });

describe('arrangement detection', () => {
  it('remote (text)', () => { expect(d('This role is fully remote within the United States.')).toMatchObject({ arrangement: 'remote', source: 'text' }); });
  it('remote (location string)', () => { expect(detectArrangement({ description: 'x', location: 'Remote - US' })).toMatchObject({ arrangement: 'remote', source: 'location' }); });
  it('"Remote-Friendly" in the location is not fully remote', () => { expect(detectArrangement({ description: 'x', location: 'Remote-Friendly (Travel Required) | San Francisco, CA' }).arrangement).toBe('unknown'); });
  it('hybrid (text)', () => { expect(d('We follow a hybrid work model with flexibility.')).toMatchObject({ arrangement: 'hybrid', officeDays: null }); });
  it('hybrid 3 days (several phrasings)', () => {
    for (const t of ['Hybrid: 3 days in office per week.', 'This is a hybrid role, in office three days a week.', 'We are in the office 3 days per week.', 'Hybrid (3 days onsite)'])
      expect(d(t), t).toMatchObject({ arrangement: 'hybrid', officeDays: 3 });
  });
  it('hybrid 4 days', () => { expect(d('Hybrid schedule, 4 days in the office each week')).toMatchObject({ arrangement: 'hybrid', officeDays: 4 }); });
  it('onsite (text), and 5 days in office', () => {
    expect(d('This position is fully on-site at our Brooklyn office.')).toMatchObject({ arrangement: 'onsite' });
    expect(d('Five days a week in the office.')).toMatchObject({ arrangement: 'onsite', officeDays: 5 });
  });
  it('unknown stays unknown, never guessed', () => {
    for (const t of ['Build great software with great people.', 'We use hybrid cloud and multi-cloud infrastructure.', 'Our remote teams collaborate across time zones.', 'Join our office-loving culture.'])
      expect(d(t), t).toEqual({ arrangement: 'unknown', officeDays: null, source: 'none', evidence: '' });
  });
  it('"not remote" is not read as remote', () => { expect(d('This is not a remote role; fully remote candidates need not apply. Fully remote? No.').arrangement).not.toBe('remote'); });
  it('structured field wins over text; office days only come from text', () => {
    expect(d('Fully remote!', { workplaceRaw: 'Hybrid' })).toMatchObject({ arrangement: 'hybrid', source: 'structured', officeDays: null });
    expect(d('Hybrid, 2 days in office.', { workplaceRaw: 'hybrid' })).toMatchObject({ arrangement: 'hybrid', officeDays: 2, source: 'structured' });
    expect(d('x', { workplaceRaw: 'OnSite' }).arrangement).toBe('onsite'); expect(d('x', { workplaceRaw: 'Hybrid (Travel-Required)' }).arrangement).toBe('hybrid'); expect(d('x', { workplaceRaw: 'On-Site' }).arrangement).toBe('onsite');
    expect(d('x', { workplaceRaw: 'Remote' }).arrangement).toBe('remote');
    expect(d('x', { workplaceRaw: 'something else' }).arrangement).toBe('unknown');
  });
});

describe('structured fields in real responses (fixtures)', () => {
  it('ashby workplaceType is read; isRemote is not used', () => {
    const jobs = parseAshby(fx('ashby'), 'Ramp');
    expect(jobs.every((j) => j.workplaceRaw === null || ['Remote', 'Hybrid', 'OnSite'].includes(j.workplaceRaw!))).toBe(true);
    expect(jobs.some((j) => j.workplaceRaw)).toBe(true);
  });
  it('lever workplaceType is read', () => { const j = parseLever(fx('lever'), 'S'); expect(j.every((x) => ['remote', 'hybrid', 'onsite'].includes(x.workplaceRaw ?? ''))).toBe(true); });
  it('greenhouse reads only "Workplace Type" / "Location Type" custom fields', () => {
    expect(greenhouseWorkplace({ metadata: [{ name: 'Workplace Type', value: 'Hybrid' }] })).toBe('Hybrid');
    expect(greenhouseWorkplace({ metadata: [{ name: 'Location Type', value: 'On-Site' }] })).toBe('On-Site');
    expect(greenhouseWorkplace({ metadata: [{ name: 'Working Model Eligibility', value: '3-Fully Remote' }] })).toBeNull();
    expect(greenhouseWorkplace({ metadata: null })).toBeNull();
    expect(parseGreenhouse(fx('greenhouse'), 'D').every((j) => j.workplaceRaw === null)).toBe(true);   // this saved response has no such field
  });
});

describe('high-demand hours note', () => {
  it('on: lists every matched phrase', () => {
    const n = hoursNote('You will be on-call, travel up to 25%, work some weekends at the client site in a fast-paced startup with 24/7 coverage and frequent travel.');
    expect(n.sort()).toEqual(['24/7', 'client site', 'fast-paced startup', 'frequent travel', 'on-call', 'travel up to', 'weekends']);
  });
  it('off: ordinary text', () => { expect(hoursNote('Build software. Standard business hours. Collaborate with the team.')).toEqual([]); });
  it('is a note only: a job with every hours phrase is still stored, scored and not penalized in rank', async () => {
    const db = openDb(':memory:'); let calls = 0;
    await processJobs(db, [mk({ description: 'On-call, 24/7, weekends, frequent travel, client site. New grads welcome.' })], async () => { calls++; return goodJson; }, stats());
    expect(calls).toBe(1);
    const r = db.prepare('SELECT filter_reason, hours_note FROM jobs').get() as any;
    expect(r.filter_reason).toBeNull(); expect(r.hours_note).toContain('on-call');
    const base = rankScore(70, 1, 'negotiable', 'hybrid', 3);
    expect(rankScore(70, 1, 'negotiable', 'hybrid', 3)).toBe(base);   // rank takes no hours input
  });
});

describe('ranking at equal fit: remote > hybrid<=3 > hybrid 4 > onsite', () => {
  const r = (a: any, days: number | null = null, tier = 1) => rankScore(70, tier, 'negotiable', a, days);
  it('order', () => {
    expect(r('remote')).toBeGreaterThan(r('hybrid', 3)); expect(r('hybrid', 3)).toBeGreaterThan(r('hybrid', 4)); expect(r('hybrid', 4)).toBeGreaterThan(r('onsite'));
    expect(r('hybrid', 1)).toBeGreaterThan(r('hybrid', 4)); expect(r('onsite')).toBeLessThan(r('unknown'));
  });
  it('holds across every location tier (arrangement step > tier spread), e.g. tier-5 remote beats tier-1 hybrid', () => {
    expect(r('remote', null, 5)).toBeGreaterThan(r('hybrid', 3, 1)); expect(r('hybrid', 3, 5)).toBeGreaterThan(r('hybrid', 4, 1)); expect(r('hybrid', 4, 5)).toBeGreaterThan(r('onsite', null, 1));
  });
  it('tier order still holds within an arrangement', () => { expect(r('remote', null, 1)).toBeGreaterThan(r('remote', null, 2)); expect(r('remote', null, 2)).toBeGreaterThan(r('remote', null, 3)); });
  it('onsite is a penalty, not a drop', async () => {
    expect(arrangementAdj('onsite', null)).toBeLessThan(0);
    const db = openDb(':memory:'); let calls = 0;
    await processJobs(db, [mk({ workplaceRaw: 'OnSite' })], async () => { calls++; return goodJson; }, stats());
    expect(calls).toBe(1); expect((db.prepare('SELECT arrangement, filter_reason FROM jobs').get() as any)).toEqual({ arrangement: 'onsite', filter_reason: null });
  });
  it('low-office = remote or hybrid with stated days <= 3', () => { expect(isLowOffice('remote', null)).toBe(true); expect(isLowOffice('hybrid', 3)).toBe(true); expect(isLowOffice('hybrid', 4)).toBe(false); expect(isLowOffice('hybrid', null)).toBe(false); expect(isLowOffice('onsite', null)).toBe(false); });
});

describe('storage + digest', () => {
  it('arrangement, office_days, source are stored; unknown is stored as unknown', async () => {
    const db = openDb(':memory:');
    await processJobs(db, [mk({ id: 'h', title: 'Software Engineer H', description: 'Hybrid, 3 days in office.' }), mk({ id: 'u', title: 'Software Engineer U' })], async () => goodJson, stats());
    const rows = Object.fromEntries((db.prepare('SELECT id, arrangement, office_days, arrangement_src FROM jobs').all() as any[]).map((x) => [x.id, x]));
    expect(rows.h).toMatchObject({ arrangement: 'hybrid', office_days: 3, arrangement_src: 'text' });
    expect(rows.u).toMatchObject({ arrangement: 'unknown', office_days: null, arrangement_src: 'none' });
  });
  const s = (score: number) => ({ score, track: 'A' as const, fit_reasons: ['x'], gaps: [], apply_priority: 'high' as const });
  const row = (company: string, arrangement: any, officeDays: number | null, extra: object = {}) => ({ key: company, company, title: 't', location: 'NYC', pay: null, url: 'u', tier: 1, payFlag: 'meets floor' as const, payDisplay: '$120,000-$150,000 base', arrangement, officeDays, hoursNote: '', score: s(80), ...extra });
  it('has a "Remote and low-office roles" section BEFORE the general ranking; shows arrangement, days, pay and hours note', () => {
    const md = buildDigest([row('Onsite Co', 'onsite', null), row('Hyb4 Co', 'hybrid', 4), row('Hyb3 Co', 'hybrid', 3, { hoursNote: 'on-call, weekends' }), row('Remote Co', 'remote', null)], '2026-01-01', 4);
    const iLow = md.indexOf('# Remote and low-office roles'), iGen = md.indexOf('# General ranking');
    expect(iLow).toBeGreaterThanOrEqual(0); expect(iLow).toBeLessThan(iGen);
    const low = md.slice(iLow, iGen);
    expect(low).toContain('Remote Co'); expect(low).toContain('Hyb3 Co'); expect(low).not.toContain('Hyb4 Co'); expect(low).not.toContain('Onsite Co');
    expect(low).toContain('hybrid, 3 office days/week'); expect(low).toContain('Hours note: possible high-demand hours: on-call, weekends'); expect(low).toContain('Pay: $120,000-$150,000 base');
    const gen = md.slice(iGen);
    expect(gen.indexOf('Remote Co')).toBeLessThan(gen.indexOf('Hyb3 Co')); expect(gen.indexOf('Hyb3 Co')).toBeLessThan(gen.indexOf('Hyb4 Co')); expect(gen.indexOf('Hyb4 Co')).toBeLessThan(gen.indexOf('Onsite Co'));
    expect(gen).toContain('Work arrangement: onsite'); expect(gen).toContain('Hours note: none flagged');
  });
});

describe('no new LLM spend', () => {
  it('profile "goal" lives outside the scored summary, so adding it does not change the cache version', () => {
    const p = loadProfile() as any;
    expect(typeof p.goal).toBe('string'); expect(p.goal).toMatch(/business/);
    expect(p.summary).not.toMatch(/parallel/i);
    const v = cacheVersion('v3'); expect(v).toBe(cacheVersion('v3', p.summary));
  });
  it('arrangement/pay changes on a rescan do not trigger re-scoring', async () => {
    const db = openDb(':memory:'); let calls = 0; const llm = async () => { calls++; return goodJson; };
    await processJobs(db, [mk()], llm, stats());
    await processJobs(db, [mk({ workplaceRaw: 'Remote' })], llm, stats());
    expect(calls).toBe(1); expect((db.prepare('SELECT arrangement FROM jobs').get() as any).arrangement).toBe('remote');
  });
});

describe('pay text: counts are not pay', () => {
  it('"85,000+ companies" is not read as a salary', () => { expect(payFromText('We automate spend for over 85,000+ companies each year, annual growth strong.').status).toBe('unlisted'); });
});
