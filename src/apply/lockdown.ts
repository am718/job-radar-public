import type { BrowserContext, Page } from 'playwright';
import { isSubmitLike, LIFTED } from './guard.js';
import { SubmitGuardError, HandoffError } from './errors.js';
export { HandoffError };

// THE AUTOMATION WRAPPER (a hard guarantee in code, active in BOTH phases, never lifted by handoff).
// Playwright's action methods are patched once per process, on the shared prototypes, so no code path in this process can:
//   - click / double-click / tap a submit-type control, or click with the raw mouse at all;
//   - press Enter (or type a newline), which submits a form from any field;
//   - run an evaluate / $eval whose source clicks, dispatches events, or calls form.submit()/requestSubmit();
//   - dispatch synthetic events.
// After handoff() the page is also off limits for every acting method (HandoffError): the tool only waits for the window to close.

const parts = (...p: string[]) => p.join('');
const FORBIDDEN_JS = new RegExp([parts('\\.sub', 'mit\\s*\\('), parts('\\.requestSub', 'mit\\s*\\('), parts('\\.cl', 'ick\\s*\\('), parts('\\.dblcl', 'ick\\s*\\('), parts('dispatch', 'Event\\s*\\('), parts('new\\s+(Mouse|Pointer|Keyboard)', 'Event')].join('|'));
const isEnter = (k: unknown) => /^(enter|numpadenter|return)$/i.test(String(k).split('+').pop()!.trim());

type Kind = 'page' | 'frame' | 'locator' | 'keyboard' | 'mouse';
const pageOf = (self: any, kind: Kind): Page | null => { try { return kind === 'page' ? self : kind === 'frame' || kind === 'locator' ? self.page() : null; } catch { return null; } };
const notLifted = (self: any, kind: Kind, what: string) => { const p = pageOf(self, kind); if (p && LIFTED.has(p)) throw new HandoffError(`${what}: this page was handed off to the human; the tool performs no further actions on it`); };
const targetOf = (self: any, kind: Kind, args: unknown[]) => (kind === 'locator' ? self : kind === 'page' || kind === 'frame' ? self.locator(String(args[0])) : null);

function wrap(proto: any, name: string, kind: Kind, pre: (self: any, args: unknown[]) => Promise<void> | void) {
  const orig = proto[name];
  if (typeof orig !== 'function') return;
  proto[name] = async function (this: any, ...args: unknown[]) { await pre(this, args); return orig.apply(this, args); };
}

function patch(page: Page) {
  const MARK = Symbol.for('job-radar.lockdown');
  const protos: [any, Kind][] = [[Object.getPrototypeOf(page), 'page'], [Object.getPrototypeOf(page.mainFrame()), 'frame'], [Object.getPrototypeOf(page.locator('body')), 'locator'], [Object.getPrototypeOf(page.keyboard), 'keyboard'], [Object.getPrototypeOf(page.mouse), 'mouse']];
  for (const [proto, kind] of protos) {
    if (proto[MARK]) continue; proto[MARK] = true;
    if (kind === 'mouse') { for (const n of ['click', 'dblclick', 'down', 'up']) wrap(proto, n, kind, () => { throw new SubmitGuardError(`raw mouse ${n} is never issued by the tool`); }); continue; }
    if (kind === 'keyboard') {
      for (const n of ['press', 'down', 'up']) wrap(proto, n, kind, (_s, a) => { if (isEnter(a[0])) throw new SubmitGuardError('the tool never presses Enter'); });
      for (const n of ['type', 'insertText']) wrap(proto, n, kind, (_s, a) => { if (/[\r\n]/.test(String(a[0]))) throw new SubmitGuardError('the tool never types a newline'); });
      continue;
    }
    // clicks: refuse submit-like targets, in every phase
    for (const n of ['click', 'dblclick', 'tap']) wrap(proto, n, kind, async (s, a) => { notLifted(s, kind, n); if (await isSubmitLike(targetOf(s, kind, a))) throw new SubmitGuardError(`refusing to ${n} a submit-like control`); });
    // key presses: Enter always refused; any key on a submit-like control refused
    wrap(proto, 'press', kind, async (s, a) => { notLifted(s, kind, 'press'); const key = kind === 'locator' ? a[0] : a[1]; if (isEnter(key)) throw new SubmitGuardError('the tool never presses Enter'); if (await isSubmitLike(targetOf(s, kind, a))) throw new SubmitGuardError('refusing to press a key on a submit-like control'); });
    for (const n of ['pressSequentially', 'type']) wrap(proto, n, kind, (s, a) => { notLifted(s, kind, n); if (a.some((x) => typeof x === 'string' && /[\r\n]/.test(x))) throw new SubmitGuardError('the tool never types a newline'); });
    wrap(proto, parts('dispatch', 'Event'), kind, () => { throw new SubmitGuardError('the tool never dispatches synthetic events'); });
    // evaluate family: refuse sources that click, dispatch or submit; refuse entirely after handoff
    for (const n of ['evaluate', 'evaluateHandle', 'evaluateAll', '$eval', '$$eval']) wrap(proto, n, kind, (s, a) => {
      notLifted(s, kind, n);
      for (const x of a) if ((typeof x === 'function' || (typeof x === 'string' && x.length > 20)) && FORBIDDEN_JS.test(String(x))) throw new SubmitGuardError(`refusing an evaluate that clicks, dispatches events or submits (${n})`);
    });
    // other acting methods: not after handoff
    for (const n of ['fill', 'check', 'uncheck', 'setChecked', 'selectOption', 'setInputFiles', 'clear', 'focus', 'hover', 'dragTo', 'selectText']) wrap(proto, n, kind, (s) => notLifted(s, kind, n));
  }
}
/** Idempotent. Patches the shared Playwright prototypes the first time a guarded context shows a page. */
export function lockdownAutomation(ctx: BrowserContext) {
  for (const p of ctx.pages()) patch(p);
  ctx.on('page', (p) => patch(p));
}
