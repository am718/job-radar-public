import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseTextPay, payFromText, resolvePay, applyPayRules, display } from '../src/pay.js';
import { parseGreenhouse } from '../src/adapters/greenhouse.js';
import { parseLever } from '../src/adapters/lever.js';
import { parseAshby } from '../src/adapters/ashby.js';
import { rankScore } from '../src/rank.js';
import { MIN_BASE_PAY } from '../src/config.js';
import { openDb } from '../src/store.js';
import { processJobs, pendingDigestRows, type ScanStats } from '../src/pipeline.js';
import { buildDigest } from '../src/digest.js';
import { writeDroppedFile } from '../src/dropped.js';
import type { Job } from '../src/types.js';

const fx = (n: string) => JSON.parse(fs.readFileSync(`fixtures/${n}.json`, 'utf8'));
const mk = (o: Partial<Job> = {}): Job => ({ source: 'ashby', id: '1', company: 'Acme', title: 'Software Engineer', location: 'New York, NY', description: 'Build things. New grads welcome.', url: 'https://x/1', ...o });
const stats = (): ScanStats => ({ fetched: 0, filtered: 0, newJobs: 0, scored: 0, llmCalls: 0, errors: [] });
const goodJson = JSON.stringify({ score: 80, track: 'A', fit_reasons: ['r'], gaps: [], apply_priority: 'high' });
const one = (t: string) => payFromText(t);

describe('config', () => { it('MIN_BASE_PAY is 115000 (annual base, all tiers)', () => expect(MIN_BASE_PAY).toBe(115_000)); });

describe('pay text formats', () => {
  it('"$115k" single value', () => { const p = one('Base salary: $115k per year'); expect([p.status, p.min, p.max]).toEqual(['listed', 115000, 115000]); });
  it('"115,000" bare comma number in pay context', () => { const p = one('The base salary is 115,000 annually.'); expect([p.status, p.min]).toEqual(['listed', 115000]); });
  it('"$115K - $135K" range', () => { const p = one('Salary range: $115K - $135K'); expect([p.min, p.max]).toEqual([115000, 135000]); });
  it('"$120,000 - $150,000" with en dash and em dash', () => {
    expect([one('Base pay range: $120,000 – $150,000').min, one('Base pay range: $120,000 – $150,000').max]).toEqual([120000, 150000]);
    expect(one('Base pay range: $120,000 — $150,000').max).toBe(150000);
  });
  it('"$120k to $150k" word separator and "$115 - 135k" shorthand', () => {
    expect([one('Salary $120k to $150k').min, one('Salary $120k to $150k').max]).toEqual([120000, 150000]);
    expect(one('Salary $115 - 135k').min).toBe(115000);
  });
  it('hourly converts to annual (x 2080)', () => { const p = one('Pay: $60 - $90 per hour'); expect([p.min, p.max]).toEqual([124800, 187200]); expect(one('Hourly wage $55/hr').min).toBe(114400); });
  it('ignores non-pay dollar amounts', () => {
    expect(one('We raised $200,000,000 in Series B funding').status).toBe('unlisted');
    expect(one('Our customers save $5M a year').status).toBe('unlisted');
    expect(one('A $2,000 relocation stipend is offered').status).toBe('unlisted');
  });
});

describe('OTE / commission / total compensation is never base', () => {
  it.each([
    'The annual on target earnings (OTE) range for this role is $80,000-$165,000.',
    'OTE: $200,000 - $260,000',
    'Total compensation of $150,000 - $200,000 including commission',
    'Commission-eligible role, target total cash $180k - $220k',
  ])('unclear: %s', (t) => { const p = one(t); expect(p.status).toBe('unclear'); expect(p.min).toBeNull(); expect(applyPayRules(p).flag).toBe('pay unlisted'); });
  it('a following sentence about total compensation does not demote a stated salary range (real Palantir wording)', () => {
    const p = one('The estimated salary range for this position is estimated to be $110,000 - $147,000/year. Total compensation for this position may also include equity and bonus.');
    expect([p.status, p.min, p.max]).toEqual(['listed', 110000, 147000]);
  });
  it('but OTE in the same sentence still does', () => { expect(one('The OTE for this position is $110,000 - $147,000/year including commission.').status).toBe('unclear'); });
  it('base range stated alone is still base', () => { expect(one('The annual base salary range for this role is $210,000-$250,000 USD.').status).toBe('listed'); });
  it('an unclear job is kept (not dropped) unless a labeled OTE ceiling is under the floor', () => {
    expect(applyPayRules(one('Commission eligible. Pay range $60,000 - $90,000')).drop).toBe(false);
    expect(applyPayRules(one('OTE $60,000 - $190,000')).drop).toBe(false);          // OTE max above the floor
    expect(applyPayRules(one('OTE $60,000 - $90,000')).drop).toBe(true);            // labeled OTE max below the floor => base is below the floor
  });
});

describe('the four rules', () => {
  const listed = (min: number, max: number) => ({ status: 'listed' as const, min, max });
  it('1. listed max below $115k: drop', () => { expect(applyPayRules(listed(90000, 114999))).toMatchObject({ drop: true, flag: 'below floor' }); });
  it('2. range spans the floor: keep, negotiable', () => {
    expect(applyPayRules(listed(100000, 130000))).toMatchObject({ drop: false, flag: 'negotiable' });
    expect(applyPayRules(listed(100000, 115000))).toMatchObject({ drop: false, flag: 'negotiable' });   // max exactly at the floor
  });
  it('3. listed min at or above floor: keep, small bonus', () => {
    const d = applyPayRules(listed(115000, 140000));
    expect(d).toMatchObject({ drop: false, flag: 'meets floor' }); expect(d.rankAdj).toBeGreaterThan(0);
    expect(rankScore(70, 1, 'meets floor')).toBeGreaterThan(rankScore(70, 1, 'negotiable'));
  });
  it('4. pay not listed or unclear: keep, flag "pay unlisted", never above a comparable listed job', () => {
    const none = applyPayRules({ status: 'unlisted', min: null, max: null }), unclear = applyPayRules({ status: 'unclear', min: null, max: null });
    expect(none).toMatchObject({ drop: false, flag: 'pay unlisted' }); expect(unclear.flag).toBe('pay unlisted');
    for (const f of ['meets floor', 'negotiable'] as const) {
      expect(rankScore(70, 2, 'pay unlisted')).toBeLessThan(rankScore(70, 2, f));
      expect(rankScore(72, 2, 'pay unlisted')).toBeLessThan(rankScore(70, 2, f));   // even 2 points better fit
    }
  });
  it('a job with no pay at all (no field, no text)', () => {
    const p = resolvePay({ description: 'A great job with great people.' });
    expect(p).toMatchObject({ status: 'unlisted', source: 'none' }); expect(display(p)).toBe('unlisted');
  });
});

describe('structured fields from real responses (fixtures)', () => {
  it('ashby: Salary component only, hourly annualized, OTE text => unclear, no compensation => text fallback', () => {
    const jobs = parseAshby(fx('ashby-pay'), 'X'), by = (t: string) => jobs.find((j) => j.title.startsWith(t))!;
    expect(resolvePay(by('Senior Analytics Engineer'))).toMatchObject({ status: 'listed', min: 110400, max: 220800, source: 'structured' });   // equity/bonus components ignored
    expect(resolvePay(by('IT Support Specialist'))).toMatchObject({ status: 'listed', min: Math.round(60.58 * 2080 * 100) / 100, source: 'structured' });
    expect(resolvePay(by('Partner Development'))).toMatchObject({ status: 'listed', min: 110000, max: 120000, source: 'structured' });   // tier summary says "Total OTE ... Commission" but the typed Salary component is trusted as base
    expect(resolvePay(by('Account Executive')).status).toBe('unlisted');
  });
  it('lever: salaryRange {min,max,currency,interval}; OTE description => unclear; absent => unlisted', () => {
    const jobs = parseLever(fx('lever-pay'), 'X'), by = (t: string) => jobs.find((j) => j.title.startsWith(t))!;
    expect(resolvePay(by('Account Executive'))).toMatchObject({ status: 'unclear' });                    // salaryRange exists but its description says OTE
    expect(resolvePay(by('Director of Product'))).toMatchObject({ status: 'listed', min: 210000, max: 250000, source: 'structured' });
    expect(resolvePay(by('Lead Solutions')).status).toBe('unlisted');
  });
  it('greenhouse: pay_input_ranges (cents), non-USD => unclear', () => {
    const jobs = parseGreenhouse(fx('greenhouse-pay'), 'X');
    const usdJobs = jobs.filter((j) => j.payRaw?.currency === 'USD'), cad = jobs.find((j) => j.payRaw?.currency === 'CAD')!;
    expect(usdJobs.length).toBeGreaterThan(0);
    expect(resolvePay(usdJobs[0])).toMatchObject({ status: 'listed', source: 'structured' });
    expect(usdJobs[0].payRaw!.min).toBe(102000);
    expect(resolvePay(cad).status).toBe('unclear');
  });
  it('sources without pay fields (older fixtures) have payRaw null/undefined, not invented values', () => {
    expect(parseGreenhouse(fx('greenhouse'), 'D').every((j) => !j.payRaw)).toBe(true);
    expect(parseLever(fx('lever'), 'S').every((j) => !j.payRaw)).toBe(true);
  });
});

describe('Ashby typed Salary beats OTE wording; Lever and Greenhouse do not', () => {
  const ashbyJob = (extra: object = {}) => parseAshby({ jobs: [{ id: 'a', title: 'Sales Engineer', location: 'New York', descriptionPlain: 'Base salary and OTE are discussed. OTE is $200,000. Commission eligible. Total compensation varies.',
    compensation: { compensationTierSummary: '$120K - $150K • Offers Commission • OTE $210K', compensationTiers: [{ tierSummary: 'OTE', components: [
      { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 120000, maxValue: 150000, summary: '$120K - $150K' }, { compensationType: 'Commission', interval: '1 YEAR', currencyCode: 'USD', minValue: null, maxValue: null, summary: 'Offers Commission' }] }] }, ...extra }] }, 'X')[0];
  it('typed Salary component + OTE text in description and tier summary => listed base (meets floor)', () => {
    const p = resolvePay(ashbyJob()); expect(p).toMatchObject({ status: 'listed', min: 120000, max: 150000, source: 'structured' }); expect(applyPayRules(p).flag).toBe('meets floor');
  });
  it('the Commission/Equity/Bonus components are still ignored (only Salary is base)', () => {
    const j = ashbyJob({ descriptionPlain: 'A great role with great people.', compensation: { compensationTierSummary: 'Offers Commission', compensationTiers: [{ components: [{ compensationType: 'Commission', interval: '1 YEAR', currencyCode: 'USD', minValue: 90000, maxValue: 200000 }] }] } });
    expect(resolvePay(j).status).toBe('unlisted');
  });
  it('Ashby is still unclear when non-USD or when only the description text has the number and it says OTE', () => {
    expect(resolvePay(ashbyJob({ compensation: { compensationTiers: [{ components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 90000, maxValue: 100000 }] }] } })).status).toBe('unclear');
    expect(resolvePay(ashbyJob({ compensation: null, descriptionPlain: 'The annual OTE range is $90,000-$140,000.' })).status).toBe('unclear');
  });
  it('Lever OTE trap and Greenhouse hourly-under-annual trap remain unclear', () => {
    expect(resolvePay({ description: '', payRaw: { min: 80000, max: 165000, interval: 'year', currency: 'USD', noteText: 'The annual on target earnings (OTE) range is $80,000-$165,000.' } }).status).toBe('unclear');
    expect(resolvePay({ description: '', payRaw: { min: 35, max: 58, interval: 'year', currency: 'USD', noteText: 'Annual Base Salary' } }).status).toBe('unclear');
    expect(resolvePay({ description: '', payRaw: { min: 150000, max: 200000, interval: 'year', currency: 'USD', noteText: 'Total compensation includes commission' } }).status).toBe('unclear');
  });
});

describe('implausible structured amounts', () => {
  it('a "yearly" range of $35-$58 (really hourly, seen in a real Greenhouse response) is unclear, not dropped as below-floor', () => {
    const p = resolvePay({ description: '', payRaw: { min: 35, max: 58, interval: 'year', currency: 'USD', noteText: 'Annual Base Salary' } });
    expect(p.status).toBe('unclear'); expect(applyPayRules(p).drop).toBe(false);
  });
});

describe('pipeline: pay rules without any LLM call for dropped jobs', () => {
  const run = async (jobs: Job[]) => { const db = openDb(':memory:'); let calls = 0; await processJobs(db, jobs, async () => { calls++; return goodJson; }, stats()); return { db, calls }; };
  const pay = (min: number, max: number) => ({ min, max, interval: 'year' as const, currency: 'USD', noteText: '' });
  it('below-floor job is dropped before scoring; others are scored and kept', async () => {
    const { db, calls } = await run([
      mk({ id: 'low', title: 'Software Engineer A', payRaw: pay(80000, 100000) }),
      mk({ id: 'span', title: 'Software Engineer B', payRaw: pay(100000, 130000) }),
      mk({ id: 'high', title: 'Software Engineer C', payRaw: pay(120000, 150000) }),
      mk({ id: 'none', title: 'Software Engineer D' }),
    ]);
    expect(calls).toBe(3);
    const flags = Object.fromEntries((db.prepare('SELECT id, pay_flag, filter_reason FROM jobs').all() as any[]).map((r) => [r.id, [r.pay_flag, r.filter_reason]]));
    expect(flags.low).toEqual(['below floor', 'pay below floor']);
    expect(flags.span).toEqual(['negotiable', null]); expect(flags.high).toEqual(['meets floor', null]); expect(flags.none).toEqual(['pay unlisted', null]);
  });
  it('applies to every location tier (remote too), not only NJ', async () => {
    const { db } = await run([mk({ id: 'r', location: 'Remote - US', payRaw: pay(60000, 90000) })]);
    expect((db.prepare('SELECT filter_reason FROM jobs').get() as any).filter_reason).toBe('pay below floor');
  });
  it('NJ needs listed pay at/above the floor range: unlisted NJ dropped, spanning/high NJ kept', async () => {
    const { db } = await run([
      mk({ id: 'nj0', location: 'Jersey City, NJ', title: 'Software Engineer E' }),
      mk({ id: 'nj1', location: 'Jersey City, NJ', title: 'Software Engineer F', payRaw: pay(120000, 140000) }),
    ]);
    const r = Object.fromEntries((db.prepare('SELECT id, filter_reason FROM jobs').all() as any[]).map((x) => [x.id, x.filter_reason]));
    expect(r.nj0).toBe('NJ requires listed pay'); expect(r.nj1).toBeNull();
  });
  it('a rescan refreshes pay columns on stored jobs without re-scoring them', async () => {
    const db = openDb(':memory:'); let calls = 0; const llm = async () => { calls++; return goodJson; };
    await processJobs(db, [mk({ id: 'a' })], llm, stats());
    expect(calls).toBe(1);
    await processJobs(db, [mk({ id: 'a', payRaw: pay(130000, 150000) })], llm, stats());
    expect(calls).toBe(1);
    expect((db.prepare('SELECT pay_flag, pay_min FROM jobs').get() as any)).toEqual({ pay_flag: 'meets floor', pay_min: 130000 });
  });
});

describe('digest shows pay on every job; unlisted in its own bottom section', () => {
  const s = (score: number) => ({ score, track: 'A' as const, fit_reasons: ['x'], gaps: [], apply_priority: 'high' as const });
  const row = (company: string, flag: any, disp: string, score = 80) => ({ key: company, company, title: 't', location: 'NYC', pay: null, url: 'u', tier: 1, payFlag: flag, payDisplay: disp, score: s(score) });
  it('sections, order, and pay text', () => {
    const md = buildDigest([row('Unl', 'pay unlisted', 'unlisted', 50), row('Hi', 'meets floor', '$120,000-$150,000 base'), row('Span', 'negotiable', '$100,000-$130,000 base'), row('Unc', 'pay unlisted', 'unlisted (unclear: mentions OTE/commission/total compensation)', 55)], '2026-01-01', 4);
    const top = md.slice(0, md.indexOf('# High fit')), bottom = md.slice(md.indexOf('# Pay unlisted'));
    expect(top).toContain('Hi'); expect(top).toContain('Span'); expect(top).not.toContain('Unl'); expect(top).not.toContain('Unc');
    expect(top).toContain('Pay: $120,000-$150,000 base (meets the $115k floor)'); expect(top).toContain('(negotiable');
    expect(bottom).toContain('Unl'); expect(bottom).toContain('Unc'); expect(bottom).toContain('Pay: unlisted (unclear');
    expect(md.indexOf('# Pay unlisted')).toBeGreaterThan(md.indexOf('## 2.'));
  });
  it('pendingDigestRows carries pay columns from the DB', async () => {
    const db = openDb(':memory:');
    await processJobs(db, [mk({ id: 'p', payRaw: { min: 120000, max: 150000, interval: 'year', currency: 'USD', noteText: '' } })], async () => goodJson, stats());
    const r = pendingDigestRows(db)[0];
    expect(r.payFlag).toBe('meets floor'); expect(r.payDisplay).toBe('$120,000-$150,000 base');
  });
});

describe('High fit, pay unclear section', () => {
  const s = (score: number) => ({ score, track: 'B' as const, fit_reasons: ['x'], gaps: [], apply_priority: 'high' as const });
  const row = (company: string, score: number, flag: any, status: string, raw: string, extra: object = {}) =>
    ({ key: company, company, title: `${company} role`, location: 'NYC', pay: null, url: `https://x/${company}`, tier: 1, payFlag: flag, payStatus: status, payRaw: raw, payDisplay: 'unlisted', arrangement: 'remote' as const, officeDays: null, hoursNote: '', score: s(score), ...extra });
  const sec = (md: string) => { const a = md.indexOf('# High fit, pay unclear'); return md.slice(a, md.indexOf('\n# ', a + 5)); };
  const topN = (n: number) => Array.from({ length: n }, (_, i) => row(`Top${i}`, 99 - i, 'meets floor', 'listed', ''));

  it('a score-80 job with OTE-only pay appears (with the raw OTE text, arrangement, score) — even with 15 confirmed-pay jobs above it', () => {
    const md = buildDigest([...topN(15), row('OteCo', 80, 'pay unlisted', 'unclear', 'The annual OTE range is $90,000-$160,000.')], '2026-01-01', 16);
    expect(md.indexOf('# High fit, pay unclear')).toBeGreaterThan(md.indexOf('## 15.'));            // right after the top 15
    expect(md.indexOf('# High fit, pay unclear')).toBeLessThan(md.indexOf('# Other jobs'));
    const h = sec(md);
    expect(h).toContain('OteCo'); expect(h).toContain('**80**'); expect(h).toContain('The annual OTE range is $90,000-$160,000.'); expect(h).toContain('Work arrangement: remote'); expect(h).toContain('Pay status: unclear');
    expect(md.slice(0, md.indexOf('# High fit'))).not.toContain('OteCo');                          // not in the top 15 (rank penalty stays)
  });
  it('a job with no pay text at all and score 65+ also appears; 64 does not', () => {
    const h = sec(buildDigest([row('NoPay', 65, 'pay unlisted', 'unlisted', ''), row('Just64', 64, 'pay unlisted', 'unlisted', '')], '2026-01-01', 2));
    expect(h).toContain('NoPay'); expect(h).toContain('no pay text found'); expect(h).not.toContain('Just64');
  });
  it('sorted by score, descending', () => {
    const h = sec(buildDigest([row('A70', 70, 'pay unlisted', 'unclear', 'x'), row('B90', 90, 'pay unlisted', 'unclear', 'y'), row('C80', 80, 'pay unlisted', 'unlisted', '')], '2026-01-01', 3));
    expect(h.indexOf('B90')).toBeLessThan(h.indexOf('C80')); expect(h.indexOf('C80')).toBeLessThan(h.indexOf('A70'));
  });
  it('a score-80 job with confirmed pay BELOW the floor does not appear: it is dropped upstream and never scored or surfaced', async () => {
    const db = openDb(':memory:'); let calls = 0;
    await processJobs(db, [mk({ id: 'low', title: 'Solutions Engineer Low', payRaw: { min: 80000, max: 100000, interval: 'year', currency: 'USD', noteText: '' } }),
      mk({ id: 'ote', title: 'Solutions Engineer Ote', source: 'lever', payRaw: { min: 80000, max: 165000, interval: 'year', currency: 'USD', noteText: 'OTE range' } })],
      async () => { calls++; return JSON.stringify({ score: 80, track: 'B', fit_reasons: ['r'], gaps: [], apply_priority: 'high' }); }, stats());
    expect(calls).toBe(1);
    const md = buildDigest(pendingDigestRows(db), '2026-01-01', 1);
    expect(sec(md)).toContain('Solutions Engineer Ote'); expect(sec(md)).toContain('OTE range'); expect(md).not.toContain('Solutions Engineer Low');
  });
  it('listed-pay jobs never appear in the section even at 90', () => {
    expect(sec(buildDigest([row('Listed', 90, 'meets floor', 'listed', '')], '2026-01-01', 1))).not.toContain('Listed');
  });
});

describe('OTE / total-comp ceiling rule', () => {
  const struct = (min: number, max: number, over: Partial<{ interval: any; currency: string | null; noteText: string }> = {}) =>
    resolvePay({ description: '', payRaw: { min, max, interval: 'year', currency: 'USD', noteText: 'Annual OTE Salary: annual on-target earnings (OTE) range', ...over } });
  it('labeled OTE $69k-$93k (USD, annual) is dropped as below floor', () => {
    const p = struct(69_000, 93_000); const d = applyPayRules(p);
    expect(p.status).toBe('unclear'); expect(p.ceiling).toBe(93_000); expect(d).toMatchObject({ drop: true, flag: 'below floor' }); expect(d.rule).toMatch(/OTE\/total-comp max \$93,000/);
  });
  it('labeled OTE $90k-$140k is NOT dropped (max above the floor): stays unclear', () => {
    const p = struct(90_000, 140_000); expect(applyPayRules(p)).toMatchObject({ drop: false, flag: 'pay unlisted' });
  });
  it('unlabeled $70k-$90k stays unclear (commission wording only, no OTE/total-comp label)', () => {
    const s = struct(70_000, 90_000, { noteText: 'Commission eligible role' }); expect(s.status).toBe('unclear'); expect(applyPayRules(s).drop).toBe(false);
    const t = payFromText('This role is commission eligible. Pay range: $70,000 - $90,000.'); expect(t.status).toBe('unclear'); expect(applyPayRules(t).drop).toBe(false);
  });
  it('hourly or non-USD labeled OTE stays unclear', () => {
    expect(applyPayRules(struct(30, 45, { interval: 'hour' })).drop).toBe(false);
    expect(applyPayRules(struct(60_000, 90_000, { currency: 'GBP' })).drop).toBe(false);
    expect(applyPayRules(struct(60_000, 90_000, { currency: 'CAD' })).drop).toBe(false);
    expect(applyPayRules(payFromText('Total compensation is $30 - $45 per hour.')).drop).toBe(false);
  });
  it('text: labeled OTE/total-comp annual dollar figure under the floor is dropped; above the floor is not', () => {
    expect(applyPayRules(payFromText('The annual on target earnings (OTE) range for this role is $70,000-$93,000.'))).toMatchObject({ drop: true });
    expect(applyPayRules(payFromText('The annual OTE range for this role is $90,000-$140,000.')).drop).toBe(false);
    expect(applyPayRules(payFromText('Total compensation of $80k - $100k including commission.')).drop).toBe(true);
  });
  it('implausibly low "annual" amounts stay unclear even if labeled OTE', () => { expect(applyPayRules(struct(35, 58)).drop).toBe(false); });
  it('Ashby typed Salary is unaffected (trusted base)', () => {
    const p = resolvePay({ description: '', payRaw: { min: 120_000, max: 150_000, interval: 'year', currency: 'USD', noteText: 'OTE $200K', trustTyped: true } });
    expect(p.status).toBe('listed'); expect(applyPayRules(p).drop).toBe(false);
  });
  it('pipeline: OTE-ceiling job is dropped before scoring and written to the dropped-for-pay file; digest footer counts it', async () => {
    const db = openDb(':memory:'); let calls = 0;
    await processJobs(db, [
      mk({ id: 'o1', title: 'Sales Engineer One', source: 'lever', payRaw: { min: 69_000, max: 93_000, interval: 'year', currency: 'USD', noteText: 'OTE range' } }),
      mk({ id: 'o2', title: 'Sales Engineer Two', source: 'lever', payRaw: { min: 90_000, max: 140_000, interval: 'year', currency: 'USD', noteText: 'OTE range' } }),
      mk({ id: 'l1', title: 'Software Engineer Low', payRaw: { min: 80_000, max: 100_000, interval: 'year', currency: 'USD', noteText: '' } }),
    ], async () => { calls++; return goodJson; }, stats());
    expect(calls).toBe(1);                                               // only the unclear OTE $90-140k job was scored
    const dir = fs.mkdtempSync('/tmp/dropped-'); const { path, count } = writeDroppedFile(db, '2026-01-01', dir);
    const txt = fs.readFileSync(path, 'utf8');
    expect(count).toBe(2); expect(txt).toContain('Sales Engineer One'); expect(txt).toContain('Software Engineer Low'); expect(txt).not.toContain('Sales Engineer Two');
    expect(txt).toMatch(/Rule: labeled OTE\/total-comp max \$93,000/); expect(txt).toMatch(/Rule: listed base max \$100,000/); expect(txt).toContain('Pay text:');
    expect(buildDigest(pendingDigestRows(db), '2026-01-01', 1, count).trimEnd().endsWith('2 jobs dropped for pay (list in dropped-for-pay file)')).toBe(true);
  });
});
