import { describe, it, expect } from 'vitest';
import { LabelSession, type LabelRow } from '../src/cli/labelcore.js';
import { checkGold } from '../src/eval/goldcheck.js';

function setup(n = 12, startProgress: LabelRow[] = []) {
  let t = 1_000_000;
  const saved: { progress: LabelRow[]; final: LabelRow[] | null; progressWrites: number } = { progress: [...startProgress], final: null, progressWrites: 0 };
  const s = new LabelSession(
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, defaultTrack: 'A' as const })),
    { loadProgress: () => [...saved.progress], saveProgress: (r) => { saved.progress = [...r]; saved.progressWrites++; }, writeFinal: (r) => { saved.final = [...r]; } },
    () => t,
  );
  /** advance clock then press */
  const key = (name: string, afterMs = 5000, ch = '') => { t += afterMs; s.press(name, ch); };
  return { s, saved, key, clock: () => t, advance: (ms: number) => { t += ms; } };
}

describe('label session guardrails', () => {
  it('saves each label as it is made', () => {
    const { s, saved, key } = setup();
    key('a'); key('m');
    expect(saved.progress.map((r) => r.label)).toEqual(['apply', 'maybe']);
    expect(s.tally).toEqual({ apply: 1, maybe: 1, skip: 0 });
  });
  it('resumes from saved progress', () => {
    const { saved, key } = setup(); key('a'); key('s');
    const again = setup(12, saved.progress);
    expect(again.s.index).toBe(2);
  });
  it('undo steps back one job and removes its saved label', () => {
    const { s, saved, key } = setup();
    key('a'); key('m'); key('s');
    expect(s.index).toBe(3);
    key('u');
    expect(s.index).toBe(2);
    expect(saved.progress.map((r) => r.key)).toEqual(['k0', 'k1']);
    key('u'); key('u');
    expect(saved.progress).toEqual([]);
    key('u'); expect(s.message).toMatch(/Nothing to undo/);
  });
  it('ignores a label arriving <1.5s after the previous label', () => {
    const { s, key } = setup();
    key('a');
    key('m', 1000);
    expect(s.labels).toHaveLength(1); expect(s.message).toMatch(/too soon/i);
    key('m', 1600); expect(s.labels).toHaveLength(2);
  });
  it('ignores key repeat (held key): events <200ms apart never label, even after 1.5s of holding', () => {
    const { s, key } = setup();
    key('a');                        // label 1
    for (let i = 0; i < 100; i++) key('a', 30); // held key: 100 events, 3s of auto-repeat
    expect(s.labels).toHaveLength(1);
    key('a', 500);                   // a deliberate fresh press after releasing
    expect(s.labels).toHaveLength(2);
  });
  it('pace warning: 10 labels averaging <4s pauses until c', () => {
    const { s, key } = setup(30);
    for (let i = 0; i < 10; i++) key('a', 2000);
    expect(s.state).toBe('paused'); expect(s.paceMessage).toMatch(/Going fast/);
    const n = s.labels.length;
    key('a', 5000); expect(s.labels).toHaveLength(n);       // labels ignored while paused
    key('c', 5000); expect(s.state).toBe('label');
    key('a', 5000); expect(s.labels).toHaveLength(n + 1);
  });
  it('no pace warning when labeling at >=4s each', () => {
    const { s, key } = setup(30);
    for (let i = 0; i < 12; i++) key('a', 4500);
    expect(s.state).toBe('label');
  });
  it('skew notice appears after 20 labels when >70% identical, not before, not when balanced', () => {
    const a = setup(40);
    for (let i = 0; i < 19; i++) a.key('a', 5000);
    expect(a.s.skewNotice).toBe('');
    a.key('a', 5000);
    expect(a.s.skewNotice).toMatch(/100%/);
    const b = setup(40);
    for (let i = 0; i < 20; i++) b.key(['a', 'm', 's'][i % 3], 5000);
    expect(b.s.skewNotice).toBe('');
  });
  it('t toggles track and the toggle is saved with the label', () => {
    const { s, saved, key } = setup();
    key('t'); key('a');
    expect(saved.progress[0].track).toBe('B');
    expect(s.track).toBe('A'); // resets to the next job's default
  });
  describe('confirm before save', () => {
    const finish = (n = 3) => { const x = setup(n); for (let i = 0; i < n; i++) x.key('a', 5000); return x; };
    const type = (x: ReturnType<typeof setup>, text: string) => { for (const c of text) x.key(c, 300, c); x.key('return', 300); };
    it('does not write the final file until "save" is typed', () => {
      const x = finish();
      expect(x.s.state).toBe('confirm'); expect(x.saved.final).toBeNull();
      type(x, 'save');
      expect(x.s.state).toBe('done'); expect(x.saved.final).toHaveLength(3);
    });
    it('anything else returns to review and writes nothing', () => {
      const x = finish();
      type(x, 'yes');
      expect(x.saved.final).toBeNull(); expect(x.s.state).toBe('label'); expect(x.s.index).toBe(2);
      x.key('m', 5000);                                  // relabel the last job
      expect(x.s.state).toBe('confirm'); expect(x.saved.progress[2].label).toBe('maybe');
    });
    it('keys typed during confirm are not treated as labels', () => {
      const x = finish();
      x.key('a', 300, 'a'); x.key('m', 300, 'm');
      expect(x.s.labels).toHaveLength(3);
    });
  });
});

describe('gold sanity checks', () => {
  const mkGold = (labels: string[], gapSec: number) => labels.map((label, i) => ({ key: `k${i}`, label, labeled_at: new Date(1e12 + i * gapSec * 1000).toISOString(), labeler: 'human' }));
  const strata = (n: number, skipFrom: number) => new Map(Array.from({ length: n }, (_, i) => [`k${i}`, i >= skipFrom ? 'obvious-skip' : 'tier1'] as [string, string]));
  it('rejects the original bad set shape (skewed, fast, skips labeled apply)', () => {
    const labels = [...Array(57).fill('apply'), 'maybe', 'maybe', 'skip'];
    const checks = checkGold(mkGold(labels, 1.6), strata(60, 45));
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(expect.arrayContaining([expect.stringMatching(/balance/), expect.stringMatching(/pace/), expect.stringMatching(/obvious/)]));
  });
  it('pace ignores proxy rows; labeler field is required', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, label: i >= 45 ? 'skip' : i % 3 === 0 ? 'maybe' : 'apply', labeled_at: new Date(1e12 + (i < 20 ? i * 12000 : 0)).toISOString(), labeler: i < 20 ? 'human' : 'ai-proxy' }));
    expect(checkGold(rows, strata(60, 45)).every((c) => c.ok)).toBe(true);
    const noField = rows.map((r) => ({ ...r, labeler: undefined }));
    expect(checkGold(noField, strata(60, 45)).find((c) => /labeler/.test(c.name))!.ok).toBe(false);
  });
  it('accepts a plausible set', () => {
    const labels = Array.from({ length: 60 }, (_, i) => (i >= 45 ? 'skip' : i % 3 === 0 ? 'maybe' : 'apply'));
    expect(checkGold(mkGold(labels, 12), strata(60, 45)).every((c) => c.ok)).toBe(true);
  });
});
