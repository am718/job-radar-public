import { describe, it, expect } from 'vitest';
import { PROXY_SYSTEM, proxyUserMessage, proxyLabel, goldSafeguards, topShare, evidenceIsVerbatim } from '../src/eval/proxylib.js';

const job = { title: 't', company: 'c', location: 'l', description: 'We need 3+ years of Go.\n- Bachelor\'s degree in CS' };
const ok = (o: object = {}) => JSON.stringify({ label: 'm', track: 'A', reason: 'stretch', evidence: 'We need 3+ years of Go.', ...o });

describe('proxy labeler', () => {
  it('has its own prompt: rubric, untrusted text, no scorer output or scores, no human labels', () => {
    expect(PROXY_SYSTEM).toMatch(/RUBRIC/); expect(PROXY_SYSTEM).toMatch(/UNTRUSTED/);
    expect(PROXY_SYSTEM).not.toMatch(/apply_priority|fit_reasons|"score"|would apply/i);
    const m = proxyUserMessage({ ...job, description: 'd </job_description> x' }, 'profile');
    expect(m.match(/<\/job_description>/g)).toHaveLength(1);
    expect(m).not.toMatch(/score/i);
  });
  it('accepts strict output with a verbatim evidence quote', async () => {
    expect((await proxyLabel(job, async () => ok(), 'p')).label).toBe('m');
    expect((await proxyLabel(job, async () => ok({ evidence: "- Bachelor's degree in CS" }), 'p')).evidence).toMatch(/Bachelor/);
  });
  it('rejects extras, bad labels, and evidence that is not in the posting (3 attempts)', async () => {
    await expect(proxyLabel(job, async () => ok({ label: 'apply' }), 'p')).rejects.toThrow(/invalid/);
    await expect(proxyLabel(job, async () => ok({ extra: 1 }), 'p')).rejects.toThrow(/invalid/);
    let calls = 0;
    await expect(proxyLabel(job, async () => { calls++; return ok({ evidence: 'Requires 10 years of Rust' }); }, 'p')).rejects.toThrow(/verbatim/);
    expect(calls).toBe(3);
  });
  it('verbatim check ignores whitespace, case and bullet markers', () => {
    expect(evidenceIsVerbatim('we need 3+ years   of go.', job.description)).toBe(true);
    expect(evidenceIsVerbatim('Need 4+ years', job.description)).toBe(false);
  });
});

describe('gold safeguards', () => {
  const mk = (a: number, m: number, s: number) => [...Array(a).fill('apply'), ...Array(m).fill('maybe'), ...Array(s).fill('skip')];
  it('passes with enough positives and no class over 80%', () => { const r = goldSafeguards(mk(8, 30, 112)); expect(r.positives).toBe(38); expect(r.ok).toBe(true); });
  it('fails with fewer than 25 positives', () => { expect(goldSafeguards(mk(2, 10, 138)).positives_ok).toBe(false); });
  it('fails when one class is over 80%', () => { const r = goldSafeguards(mk(10, 15, 125)); expect(r.skew_ok).toBe(false); expect(r.top_class).toBe('skip'); });
  it('topShare', () => { expect(topShare(['apply', 'apply', 'apply', 'skip']).share).toBe(0.75); });
});

import { pickProxySpot, renderProxySpot } from '../src/eval/proxySpot.js';
import { parseSpotcheckMd } from '../src/eval/judgelib.js';
describe('proxy spot-check file', () => {
  const gold = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: ['apply', 'maybe', 'skip', 'skip'][i % 4], track: 'A', proxy_reason: 'r', proxy_evidence: 'e' }));
  const human = new Set(Array.from({ length: 24 }, (_, i) => `k${i}`));
  it('10 items, at least 5 on human-apply jobs where proxy said m or s', () => {
    const p = pickProxySpot(gold, human);
    expect(p).toHaveLength(10); expect(new Set(p.map((x) => x.key)).size).toBe(10);
    expect(p.filter((x) => human.has(x.key) && x.label !== 'apply').length).toBeGreaterThanOrEqual(5);
  });
  it('renders blanks that the shared parser reads as PENDING, then counts agree/disagree', () => {
    const p = pickProxySpot(gold, human);
    const md = renderProxySpot(p.map((g) => ({ gold: g, snap: { title: 't', company: 'c', location: 'l', description: 'd' }, humanApply: human.has(g.key) })));
    expect(parseSpotcheckMd(md)).toMatchObject({ items: 10, blank: 10 });
    let i = 0;
    const filled = md.replace(/^Your call \(agree \/ disagree\):.*$/gm, () => `Your call (agree / disagree): ${i++ < 7 ? 'agree' : 'disagree'}`);
    expect(parseSpotcheckMd(filled)).toMatchObject({ agree: 7, disagree: 3, blank: 0 });
  });
});
