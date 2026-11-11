export type LabelValue = 'apply' | 'maybe' | 'skip';
export interface Item { key: string; defaultTrack: 'A' | 'B' }
export interface LabelRow { key: string; label: LabelValue; track: 'A' | 'B'; labeled_at: string }
export interface Store { loadProgress(): LabelRow[]; saveProgress(rows: LabelRow[]): void; writeFinal(rows: LabelRow[]): void }

export const MIN_GAP_AFTER_LABEL_MS = 1500;  // ignore any key arriving sooner than this after a label
export const MIN_EVENT_GAP_MS = 200;         // a key arriving <200ms after ANY previous key is auto-repeat, not a fresh press
export const PACE_WINDOW = 10;
export const PACE_MIN_AVG_MS = 4000;
export const SKEW_AFTER = 20;
export const SKEW_SHARE = 0.7;

export type State = 'label' | 'paused' | 'confirm' | 'done';

/** Pure labeling state machine (no TTY, injectable clock/store) so the guardrails are testable. */
export class LabelSession {
  labels: LabelRow[];
  state: State = 'label';
  track: 'A' | 'B';
  message = '';
  private lastLabelAt: number;
  private lastEventAt = -Infinity;
  private paceStamps: number[];     // timestamps (ms) of labels since session start / last pause-continue; first entry = baseline
  private buf = '';

  constructor(public items: Item[], private store: Store, private now: () => number) {
    this.labels = store.loadProgress();
    this.lastLabelAt = -Infinity;
    this.paceStamps = [now()];
    this.track = this.items[this.index]?.defaultTrack ?? 'A';
    if (this.labels.length >= items.length) this.state = 'confirm';
  }
  get index() { return this.labels.length; }
  get current(): Item | undefined { return this.items[this.index]; }
  get tally() { return { apply: this.count('apply'), maybe: this.count('maybe'), skip: this.count('skip') }; }
  private count(l: LabelValue) { return this.labels.filter((x) => x.label === l).length; }
  get typed() { return this.buf; }

  /** Skew notice (non-blocking): after 20 labels, >70% identical. */
  get skewNotice(): string {
    if (this.labels.length < SKEW_AFTER) return '';
    const t = this.tally, n = this.labels.length;
    const [name, top] = (Object.entries(t) as [string, number][]).sort((a, b) => b[1] - a[1])[0];
    return top / n > SKEW_SHARE ? `Check: ${Math.round((top / n) * 100)}% of your labels so far are "${name}". Is that what you intend?` : '';
  }

  /** Handle one key event. name = key name ('a','m','s','t','u','c','return','backspace',...), ch = typed character. */
  press(name: string, ch = ''): void {
    const t = this.now();
    const gap = t - this.lastEventAt;
    this.lastEventAt = t;
    this.message = '';

    if (this.state === 'confirm') return this.confirmKey(name, ch);
    if (this.state === 'paused') {
      if (name === 'c') { this.state = 'label'; this.paceStamps = [t]; this.lastLabelAt = t; } // fresh pace window; also gives a 1.5s cool-down
      return;
    }
    if (this.state === 'done') return;

    if (name === 't') { this.track = this.track === 'A' ? 'B' : 'A'; return; }
    if (name === 'u') {
      if (!this.labels.length) { this.message = 'Nothing to undo.'; return; }
      this.labels.pop(); this.store.saveProgress(this.labels);
      this.state = 'label'; this.track = this.current!.defaultTrack; this.paceStamps = [t]; this.lastLabelAt = t;
      this.message = 'Undid last label.';
      return;
    }
    const label = ({ a: 'apply', m: 'maybe', s: 'skip' } as Record<string, LabelValue>)[name];
    if (!label) return;
    if (gap < MIN_EVENT_GAP_MS) { this.message = 'Ignored: key repeat.'; return; }
    if (t - this.lastLabelAt < MIN_GAP_AFTER_LABEL_MS) { this.message = 'Ignored: too soon after the last label.'; return; }

    this.labels.push({ key: this.current!.key, label, track: this.track, labeled_at: new Date(t).toISOString() });
    this.store.saveProgress(this.labels);
    this.lastLabelAt = t;
    this.paceStamps.push(t);
    if (this.labels.length >= this.items.length) { this.state = 'confirm'; this.buf = ''; return; }
    this.track = this.current!.defaultTrack;
    if (this.paceTooFast()) this.state = 'paused';
  }

  private paceTooFast(): boolean {
    const s = this.paceStamps;
    if (s.length < PACE_WINDOW + 1) return false;       // need 10 intervals
    const w = s.slice(-(PACE_WINDOW + 1));
    return (w[w.length - 1] - w[0]) / PACE_WINDOW < PACE_MIN_AVG_MS;
  }
  get paceMessage() { return this.state === 'paused' ? 'Going fast. Read the description before labeling. Press c to continue.' : ''; }

  private confirmKey(name: string, ch: string) {
    if (name === 'backspace') { this.buf = this.buf.slice(0, -1); return; }
    if (name !== 'return') { if (ch && ch.length === 1) this.buf += ch; return; }
    const typed = this.buf.trim(); this.buf = '';
    if (typed === 'save') { this.store.writeFinal(this.labels); this.state = 'done'; this.message = 'Saved eval/gold.jsonl.'; return; }
    // anything else: go back one job so the user can review (u steps back further)
    this.labels.pop(); this.store.saveProgress(this.labels);
    this.state = 'label'; this.track = this.current!.defaultTrack; this.paceStamps = [this.now()]; this.lastLabelAt = this.now();
    this.message = 'Not saved. Review: relabel this job, or press u to step back further.';
  }
}
