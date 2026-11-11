import type { Locator } from 'playwright';

// REAL INPUT, not direct value assignment. React (Ashby, and parts of Greenhouse) keeps form state in JS and learns about a change from genuine input events:
// setting el.value in a script updates the DOM (the field LOOKS filled) but the framework's state stays empty, so Submit later says the field is missing.
// typeValue focuses the control, clears it, sends real key events for short single-line values (long or multi-line text goes in as one real text-insertion event),
// then blurs, so the framework's onChange / onBlur validation runs exactly as it does for a person typing.
// Nothing here presses Enter, and the automation wrapper (lockdown.ts) refuses a typed newline.
export const TYPE_KEYS_MAX = 160;

export async function typeValue(loc: Locator, val: string, o: { blur?: boolean; timeout?: number } = {}): Promise<void> {
  const timeout = o.timeout ?? 8000;
  await loc.focus({ timeout });
  await loc.fill('', { timeout });                       // a genuine input event that empties the field (a leftover value would be appended to otherwise)
  if (!/[\r\n]/.test(val) && val.length <= TYPE_KEYS_MAX) await loc.pressSequentially(val, { delay: 3, timeout: Math.max(timeout, 3000 + val.length * 40) });
  else await loc.fill(val, { timeout });                 // text insertion event, same as a paste
  if (o.blur !== false) await blurField(loc);
}

export const blurField = (loc: Locator) => loc.evaluate((el) => (el as HTMLElement).blur(), undefined, { timeout: 2000 }).catch(() => {});

export interface FieldState { dom: string | boolean; react: string | boolean | null; mismatch: boolean; ariaInvalid: boolean; cssInvalid: boolean; required: boolean; empty: boolean; error: string }

/** Reads the form's OWN view of a control: the DOM value, the value the framework holds in its props (React), aria-invalid, native validity, required-and-empty, and a visible error message. */
export async function readFieldState(loc: Locator): Promise<FieldState | null> {
  return loc.evaluate((el: any) => {
    const rk = Object.keys(el).find((k) => k.startsWith('__reactProps'));
    const props = rk ? el[rk] : null;
    const isCheck = el.type === 'checkbox' || el.type === 'radio';
    const dom = isCheck ? !!el.checked : String(el.value ?? '');
    let react: string | boolean | null = null;
    if (props) { if (isCheck) { if ('checked' in props && props.checked != null) react = !!props.checked; } else if ('value' in props && props.value != null) react = String(props.value); }
    const mismatch = react !== null && (isCheck ? react !== dom : react !== dom);
    const ariaInvalid = el.getAttribute('aria-invalid') === 'true' || !!el.closest('[aria-invalid="true"]');
    const cssInvalid = !!el.validity && !el.validity.valid;
    const required = !!el.required || el.getAttribute('aria-required') === 'true';
    const empty = isCheck ? !dom : String(dom).trim() === '';
    const box = el.closest('[data-field-path], [class*="fieldEntry"], li.application-question, .field, .form-group, [class*="formField"]') ?? el.parentElement?.parentElement;
    // an error message is an element that says so by role or by a class TOKEN (error / invalid, e.g. "_error_1x2"), is visible, has text and does not contain the control.
    // A bare substring match is wrong: rich-text editors use class "ProseMirror", which contains "rror".
    const isErr = (e: any) => e !== el && !e.contains(el) && (e.getAttribute('role') === 'alert' || /(^|[^a-z])(error|invalid)([^a-z]|$)/i.test(String(e.className?.baseVal ?? e.className ?? ''))) && (e.offsetWidth || e.offsetHeight) && (e.textContent ?? '').trim();
    const err = box ? Array.from(box.querySelectorAll('[role="alert"], [class]')).find(isErr) : null;
    const error = ((err as any)?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { dom, react, mismatch, ariaInvalid, cssInvalid, required, empty, error };
  }, undefined, { timeout: 2000 }).catch(() => null);
}

/** Why the form's own state says this control is not really filled (null = it is). */
export function invalidWhy(s: FieldState | null): string | null {
  if (!s) return null;
  if (s.mismatch) return 'the page shows the value but the form\'s own state does not hold it (typed-in value did not register)';
  if (s.required && s.empty) return 'required and empty according to the form';
  if (s.ariaInvalid) return s.error ? `marked invalid by the form: "${s.error}"` : 'marked invalid by the form (aria-invalid)';
  if (s.cssInvalid) return 'rejected by the form\'s own validation (native validity)';
  if (s.error) return `the form shows an error: "${s.error}"`;
  return null;
}
