import path from 'node:path';
import type { Page, Locator } from 'playwright';
import type { Answers } from './answers.js';
import { isProvided } from './answers.js';
import { classify, RESTRICTED, type Key } from './classify.js';
import { safeClick } from './guard.js';
import { typeValue, blurField, readFieldState, invalidWhy } from './typed.js';

export interface Ctl {
  jr: number; tag: string; type: string; id: string; name: string; role: string;
  question: string;        // label / question text
  placeholder?: string;    // placeholder text (some forms hint "cover letter" only here)
  option: string;          // own option text for radio/checkbox, else ''
  options: string[];       // native <select> options
  group: string;           // radio/checkbox group name (or '')
  required: boolean; buttons?: string[];
}
export interface FillCtx { resumePath: string | null; track: 'A' | 'B'; note: string | null; letter?: string | null; letterPdf?: string | null; letterWhy?: string; letterSkipped?: boolean }
/** Why a field ended up blank. empty = you left it empty in answers.json; legal = legal/attestation/demographic rule; custom = a question the matcher does not know;
 *  matcher = a field it knows but could not fill (dropdown option mismatch, widget error). */
export type Cause = 'empty' | 'legal' | 'custom' | 'matcher';
export type CheckItem = 'name' | 'email' | 'phone' | 'resume' | 'cover letter';
export interface Check { item: CheckItem; status: 'filled' | 'MISSING' | 'n/a' | 'skipped'; detail: string }
export const missingChecks = (rep: { checks: Check[] }) => rep.checks.filter((c) => c.status === 'MISSING');
export interface FillReport {
  filled: { field: string; key: Key; value: string }[];
  blank: { field: string; reason: string; cause: Cause; required?: boolean }[];
  checks: Check[];
  unregistered?: { field: string; why: string }[];   // text the page SHOWS but the form's own state/validation does not accept: counted as NOT FILLED
  reapplied: string[];   // fields the PAGE cleared after they were filled (e.g. Greenhouse resets the form when the phone Country changes) and that were filled again   // end-of-run VERIFY pass: the five essentials re-read from the live form
  uncertain: { field: string; why: string }[];
  notePlacedInForm: boolean;
  letterStatus: 'attached' | 'pasted' | 'saved only' | 'none';   // cover letter: PDF uploaded / text pasted / left in prepared/ / not generated
}

/** Reads every real form control (inert: only sets a data-jr attribute used to find it again). */
export async function extractControls(page: Page): Promise<Ctl[]> {
  return page.evaluate(() => {
    const txt = (e: Element | null) => (e?.textContent || '').replace(/\s+/g, ' ').trim();
    const out: any[] = [];
    let n = 0;
    const vis = (el: HTMLElement) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0); };
    const labelFor = (el: HTMLElement) => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) { const t = lb.split(/\s+/).map((i) => txt(document.getElementById(i))).join(' ').trim(); if (t) return t; }
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && txt(l)) return txt(l); }
      const q = el.closest('li.application-question'); const al = q?.querySelector('.application-label'); if (al && txt(al)) return txt(al);
      const fe = el.closest('[data-field-path], [class*="fieldEntry"]'); const fl = fe?.querySelector('label'); if (fl && txt(fl)) return txt(fl);   // Ashby: the question title is a sibling label whose for= does not match the input id
      const aria = el.getAttribute('aria-label'); if (aria) return aria;
      const cl = el.closest('label'); if (cl && cl.querySelectorAll('input,select,textarea').length === 1 && txt(cl)) return txt(cl);
      return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    };
    const groupQuestion = (el: HTMLElement) => {
      const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend'); if (lg && txt(lg)) return txt(lg);
      const fl = fs?.querySelector(':scope > label'); if (fl && txt(fl)) return txt(fl);   // Ashby radio groups: <fieldset><label class=question-title>
      const q = el.closest('li.application-question'); const al = q?.querySelector('.application-label'); if (al && txt(al)) return txt(al);
      const g = el.closest('[role=group],[role=radiogroup]'); if (g) { const l = g.getAttribute('aria-label') || txt(document.getElementById(g.getAttribute('aria-labelledby') || '')); if (l) return l; }
      let p: HTMLElement | null = el.parentElement;
      for (let i = 0; i < 5 && p; i++, p = p.parentElement) { const c = p.querySelector('legend, [class*=question], [class*=label]:not(input)'); if (c && txt(c) && !c.contains(el)) return txt(c); }
      return '';
    };
    document.querySelectorAll('input, textarea, select').forEach((node) => {
      const el = node as HTMLInputElement;
      const type = (el.getAttribute('type') || (el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(type)) return;
      if (el.getAttribute('aria-hidden') === 'true' && type !== 'file') return;
      if (el.disabled) return;
      if (type !== 'file' && !vis(el)) return;
      if (type === 'file' && el.closest('[class*="autofill"]')) return;   // Ashby "Autofill from resume": not the resume field; the real Resume input is separate
      el.setAttribute('data-jr', String(n));
      const isChoice = type === 'radio' || type === 'checkbox';
      const ownLabel = isChoice && el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const optText = isChoice ? (txt(ownLabel) || txt(el.closest('label')) || el.getAttribute('value') || '') : '';
      out.push({
        jr: n++, tag: el.tagName.toLowerCase(), type, id: el.id || '', name: el.getAttribute('name') || '', role: el.getAttribute('role') || '',
        question: isChoice ? groupQuestion(el) : labelFor(el), option: optText, placeholder: el.getAttribute('placeholder') || '',
        options: el.tagName === 'SELECT' ? Array.from((el as unknown as HTMLSelectElement).options).map((o) => o.text.trim()).filter(Boolean) : [],
        group: isChoice ? (el.getAttribute('name') || '') : '', required: el.required || el.getAttribute('aria-required') === 'true',
      });
    });
    // yes/no style button groups (type=button): a container whose buttons are the answer choices
    const seen = new Set<Element>();
    document.querySelectorAll('button').forEach((b) => {
      const par = b.parentElement; if (!par || seen.has(par)) return;
      const bs = Array.from(par.querySelectorAll(':scope > button')); if (bs.length < 2 || bs.length > 6) return;
      const texts = bs.map((x) => txt(x)); if (!texts.every((t) => t.length > 0 && t.length < 40)) return;
      if (bs.some((x) => /submit|apply|send|attach|dropbox|google drive|locate|enter manually/i.test(txt(x)) || (x.getAttribute('type') || '') === 'submit')) return;
      seen.add(par);
      const q = txt(par.parentElement?.querySelector(':scope > label, :scope > legend') ?? null) || Array.from(par.children).filter((c) => c.tagName !== 'BUTTON').map((c) => txt(c)).join(' ') || txt(par.previousElementSibling) || txt(par.parentElement?.querySelector('label, legend, [class*=question], [class*=label]') ?? null);
      bs.forEach((x, i) => x.setAttribute('data-jr', `b${n}-${i}`));
      out.push({ jr: n++, tag: 'buttons', type: 'buttons', id: '', name: '', role: '', question: q, option: '', options: [], group: '', required: false, buttons: texts, bprefix: `b${n - 1}` });
    });
    return out;
  });
}

export const US_STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
export const stateFull = (st?: string | null) => (st ? US_STATES[st.trim().toUpperCase()] ?? st.trim() : '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export interface PickResult { option: string | null; uncertain: boolean; ambiguous?: string[] }
const words = (s: string) => norm(s).split(' ').filter(Boolean);
const hasWords = (hay: string, needle: string) => ` ${norm(hay)} `.includes(` ${norm(needle)} `);
const DECLINE_ANS = /\b(decline|prefer not|rather not|do not wish|don t wish|not to say|no answer)\b/;
const DECLINE_OPT = /\b(decline|prefer not|rather not|not wish to|don t wish|do not wish|do not want|not to say|choose not)\b/;
/** Answer -> phrasings that may appear in an option (whole words only, so "male" never matches "female"). */
const SYNONYMS: [RegExp, string[]][] = [
  [/^(male|man|cis ?male|cisgender man)$/, ['man', 'male', 'cisgender man']], [/^(female|woman|cis ?female|cisgender woman)$/, ['woman', 'female', 'cisgender woman']],
  [/^(heterosexual|straight)$/, ['heterosexual', 'straight']], [/^(gay|lesbian|gay or lesbian)$/, ['gay', 'lesbian', 'gay or lesbian']],
  [/^(non ?binary)$/, ['non binary', 'nonbinary']], [/^(us citizen|u s citizen|citizen)$/, ['us citizen', 'u s citizen', 'citizen']],
];
/** Pick the option that matches an answer. Exact first; then decline phrasing, yes/no leading words ("Yes" -> "Yes, I am authorized", "No" -> "No, I am not a veteran"),
 *  synonyms (Male -> Man) and whole-word containment (Asian -> "Asian (South Asian)"). When SEVERAL options fit (e.g. "Asian" with East/South/Southeast Asian) nothing is chosen
 *  and `ambiguous` lists them: the tool never guesses. `restricted` (legal/demographic) skips the loose substring fallback only. */
export function pickOption(options: string[], answer: string, restricted: boolean): PickResult {
  const a = norm(answer);
  if (!a) return { option: null, uncertain: false };
  const exact = options.filter((o) => norm(o) === a);
  if (exact.length >= 1) return { option: exact[0], uncertain: false };
  const one = (hits: string[]): PickResult | null => (hits.length === 1 ? { option: hits[0], uncertain: true } : hits.length > 1 ? { option: null, uncertain: false, ambiguous: hits } : null);
  if (DECLINE_ANS.test(a)) { const r = one(options.filter((o) => DECLINE_OPT.test(norm(o)))); if (r) return r; }
  const yn = /^(yes|y|true)$/.test(a) ? 'yes' : /^(no|n|false)$/.test(a) ? 'no' : null;
  if (yn) {
    const lead = options.filter((o) => { const w = words(o); return yn === 'yes' ? w[0] === 'yes' : w[0] === 'no' || w[0] === 'not'; });
    const loose = options.filter((o) => yn === 'no' && /^(i am not|i do not|i have no|i did not)\b/.test(norm(o)) && !DECLINE_OPT.test(norm(o)));   // only when no option starts with "No"
    const hit = lead.length ? lead : loose;
    const r = one(hit); if (r) return r;
    return { option: null, uncertain: false };
  }
  for (const [re, cands] of SYNONYMS) if (re.test(a)) { const r = one(options.filter((o) => cands.some((c) => norm(o) === c || hasWords(o, c)))); if (r) return r; }
  if (!restricted && /^[a-z]{2}$/.test(a) && US_STATES[a.toUpperCase()]) {      // "NY" -> "New York" for state dropdowns (never for legal answers)
    const full = norm(US_STATES[a.toUpperCase()]); const hit = options.filter((o) => norm(o) === full);
    if (hit.length === 1) return { option: hit[0], uncertain: true };
  }
  const whole = one(options.filter((o) => hasWords(o, a) || (!restricted && norm(o).length > 2 && hasWords(a, o))));   // every word of the answer appears, whole-word, in the option (or the reverse)
  if (whole) return whole;
  if (restricted) return { option: null, uncertain: false };
  const near = options.filter((o) => norm(o).startsWith(a) || a.startsWith(norm(o)) || norm(o).includes(a));
  return near.length === 1 ? { option: near[0], uncertain: true } : { option: null, uncertain: false, ...(near.length > 1 ? { ambiguous: near } : {}) };
}
/** Why no option was chosen: ambiguity is a "needs your answer", never a guess. */
export const noMatchReason = (options: string[], ans: string, r: PickResult) =>
  r.ambiguous ? `needs your answer: "${ans}" fits several options (${r.ambiguous.join(' / ')}); set the answer to exactly one of them` : `"${ans}" does not match an option (${options.slice(0, 8).join(' / ')})`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function gradParts(g?: string | null): { month: string | null; year: string | null } {
  const m = /^(\d{4})-(\d{2})/.exec(g ?? ''); return m ? { year: m[1], month: MONTHS[Number(m[2]) - 1] } : { month: null, year: null };
}

/** The value the owner has provided for a key. Never invented; null => leave blank and list. */
export function valueFor(key: Key, a: Answers, ctx: FillCtx): string | null {
  const pick = (v?: string | null) => (isProvided(v) ? v!.trim() : null);
  const names = (pick(a.name) ?? '').split(/\s+/);
  const A = a.answers ?? {};
  switch (key) {
    case 'first_name': return pick(a.first_name) ?? (names.length > 1 ? names[0] : null);
    case 'last_name': return pick(a.last_name) ?? (names.length > 1 ? names.slice(1).join(' ') : null);
    case 'full_name': return pick(a.name);
    case 'preferred_name': return pick(a.preferred_name);
    case 'email': return pick(a.email); case 'phone': return pick(a.phone);
    case 'city': return pick(a.city); case 'state': return pick(a.state); case 'country': return pick(a.country);
    case 'location': return pick(a.city) && pick(a.state) ? `${pick(a.city)}, ${pick(a.state)}` : pick(a.city);
    case 'full_address': return pick(a.address); case 'twitter': return pick(a.twitter);
    case 'linkedin': return pick(a.linkedin); case 'github': return pick(a.github);
    case 'portfolio': return pick(a.portfolio) ?? pick(a.website); case 'website': return pick(a.website) ?? pick(a.portfolio);
    case 'school': return pick(a.school); case 'degree': return pick(a.degree); case 'major': return pick(a.major);
    case 'current_company': return pick(a.current_company);
    case 'edu_end_month': return gradParts(a.graduation_date).month; case 'edu_end_year': return gradParts(a.graduation_date).year;
    case 'how_did_you_hear': return pick(A.how_did_you_hear); case 'salary_expectation': return pick(A.salary_expectation); case 'start_date': return pick(A.start_date);
    case 'note_field': return ctx.note;
    case 'cover_letter_text': return ctx.letter ?? null;
    default:
      if ((RESTRICTED as Set<string>).has(key) && key !== 'restricted_other') return pick((A as Record<string, string | null | undefined>)[key]);
      return null;                                                       // edu_start_*, restricted_other, resume, unknown: nothing to type
  }
}

function customAnswer(a: Answers, question: string): string | null {
  for (const c of a.custom_answers ?? []) {
    if (!isProvided(c.answer)) continue;
    const m = /^\/(.+)\/([a-z]*)$/.exec(c.match);
    const hit = m ? new RegExp(m[1], m[2] || 'i').test(question) : question.toLowerCase().includes(c.match.toLowerCase());
    if (hit) return c.answer.trim();
  }
  return null;
}

/** Autocomplete for a city/location: tries the owner's exact location_query, then "City, State", then "City"; picks an option only if it matches. */
async function fillLocationCombobox(page: Page, input: Locator, field: string, a: Answers): Promise<{ option: string | null; tried: string[]; seen: string[]; uncertain: boolean }> {
  const city = isProvided(a.city) ? a.city!.trim() : '', st = stateFull(a.state);
  const queries = [isProvided(a.location_query) ? a.location_query!.trim() : '', city && st ? `${city}, ${st}` : '', city].filter(Boolean);
  const tried: string[] = [], seen: string[] = [];
  for (const q of queries) {
    tried.push(q);
    await safeClick(input, `open location "${field}"`);
    await typeValue(input, q.length > 40 ? q.slice(0, 40) : q, { blur: false });
    const opts = page.locator('[role="option"]:visible');
    await opts.first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});   // the suggestions come from a remote autocomplete API: give it time
    if (!(await opts.count())) { await input.fill(''); await typeValue(input, q.length > 40 ? q.slice(0, 40) : q, { blur: false }); await opts.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}); }   // one re-type if nothing came back
    const texts = (await opts.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    seen.push(...texts);
    const n = (x: string) => norm(x);
    let pick = texts.find((t) => n(t) === n(q)) ?? null, uncertain = false;
    if (!pick && st) { const hits = texts.filter((t) => n(t).includes(n(st)) && (!city || n(t).includes(n(city)))); if (hits.length >= 1) { pick = hits[0]; uncertain = true; } }
    if (pick) { await safeClick(opts.filter({ hasText: pick }).first(), `choose "${pick}" in "${field}"`); return { option: pick, tried, seen, uncertain: uncertain || true }; }
    await input.fill('');
  }
  return { option: null, tried, seen, uncertain: false };
}

export async function prefill(page: Page, answers: Answers, ctx: FillCtx, fs_: { exists: (p: string) => boolean }): Promise<FillReport> {
  const rep: FillReport = { filled: [], blank: [], checks: [], reapplied: [], unregistered: [], uncertain: [], notePlacedInForm: false, letterStatus: ctx.letter ? 'saved only' : 'none' };
  const controls = await extractControls(page);
  const label = (c: Ctl) => (c.question || c.name || c.id || c.type).replace(/\s+/g, ' ').replace(/\*|✱/g, '').trim().slice(0, 110);
  const loc = (c: Ctl): Locator => page.locator(`[data-jr="${c.jr}"]`);
  const handledGroups = new Set<string>();
  // Pages re-render and RESET values while we fill (Greenhouse clears everything typed so far when the phone Country is chosen). Every successful fill registers a check + re-apply
  // so a reconcile pass after the loop can re-read each field and fill again whatever the page cleared.
  const redo: { field: string; check: () => Promise<boolean>; apply: () => Promise<void> }[] = [];
  const sameText = (a: string, b: string) => a === b || (/\d/.test(b) && a.replace(/\D/g, '') === b.replace(/\D/g, '') && a.replace(/\D/g, '').length > 0);   // phone widgets reformat "5551234567" to "(555) 123-4567"
  const shownIn = async (input: Locator, text: string) => norm(await input.evaluate((el) => { const box = el.closest('.select__container, .select-shell, [class*="select"], [class*="autocomplete"], [class*="inputContainer"]') ?? el.parentElement?.parentElement; return ((box as HTMLElement | null)?.innerText ?? '') + ' ' + ((el as HTMLInputElement).value ?? ''); }, undefined, { timeout: 2000 }).catch(() => '')).includes(norm(text));
  // warnings raised right after a pick ("does not visibly show it") are re-checked at the end, once the page has settled; they are dropped if the value is visible by then
  const touched: { field: string; loc: Locator }[] = [];   // text controls we typed into: re-read against the form's OWN validation state at the end
  const lateVis: { field: string; match: RegExp; check: () => Promise<boolean> }[] = [];
  let curReq = false;
  const blank = (field: string, reason: string, cause: Cause) => rep.blank.push({ field, reason, cause, required: curReq });
  const T: Record<CheckItem, Ctl[]> = { name: [], email: [], phone: [], resume: [], 'cover letter': [] };   // controls the VERIFY pass re-reads
  const legalReason = 'legal/attestation/demographic question: no exact answer in answers.json';

  const dbg = process.env.JR_DEBUG_FILL ? async (after: string) => console.error(`[debug] after ${after}: first_name=${JSON.stringify(await page.locator('[id="first_name"]').inputValue({ timeout: 2000 }).catch(() => 'n/a'))} email=${JSON.stringify(await page.locator('[id="email"]').inputValue({ timeout: 2000 }).catch(() => 'n/a'))}`) : null;
  let prevField = '(start)';
  for (const c of controls) {
    if (dbg) await dbg(`${new Date().toISOString().slice(14, 23)} ${prevField}`);
    const field = label(c); prevField = field;
    curReq = c.required || /[*✱]/.test(c.question);
    const custom = customAnswer(answers, `${c.question} ${c.option}`.trim());
    let key = classify(`${c.question} ${c.type === 'file' ? `${c.id} ${c.name}` : ''}`);
    if (key === 'unknown' && c.tag === 'textarea' && /cover\s*letter/i.test(c.placeholder ?? '')) key = 'cover_letter_text';   // e.g. Lever: label "Additional information", placeholder "Add a cover letter or anything else..."
    if (c.type === 'file') key = /resume|cv/i.test(`${c.id} ${c.name} ${c.question}`) ? 'resume' : /cover/i.test(`${c.id} ${c.name} ${c.question}`) ? 'cover_letter_file' : key === 'resume' ? 'resume' : 'unknown';
    const restricted = (RESTRICTED as Set<string>).has(key);
    if (key === 'first_name' || key === 'last_name' || key === 'full_name') T.name.push(c); else if (key === 'email') T.email.push(c); else if (key === 'phone' && c.type !== 'file') T.phone.push(c);
    else if (c.type === 'file' && key === 'resume') T.resume.push(c); else if ((c.type === 'file' && key === 'cover_letter_file') || key === 'cover_letter_text') T['cover letter'].push(c);
    try {
      // ---- file uploads (setInputFiles is not a click)
      if (c.type === 'file') {
        if (key === 'resume') {
          if (!ctx.resumePath) { blank('Resume upload', `no resume path for track ${ctx.track} in answers.json`, 'empty'); continue; }
          if (!fs_.exists(ctx.resumePath)) { blank('Resume upload', `file not found: ${ctx.resumePath}`, 'empty'); continue; }
          await loc(c).setInputFiles(ctx.resumePath);
          { const rp = ctx.resumePath, lc = loc(c); redo.push({ field: 'Resume upload', check: () => fileOk(page, lc, path.basename(rp)), apply: () => lc.setInputFiles(rp, { timeout: 4000 }) }); }
          const shown = await fileShown(page, loc(c), path.basename(ctx.resumePath));
          rep.filled.push({ field: 'Resume upload', key, value: `${ctx.resumePath} (resume ${ctx.track}, chosen from the job's track)${shown ? ' - file name shown on the form' : ''}` });
          if (!shown) { rep.uncertain.push({ field: 'Resume upload', why: 'file is set on the input but the page does not display its name; check it' }); const lc2 = loc(c), nm = path.basename(ctx.resumePath); lateVis.push({ field: 'Resume upload', match: /does not display/, check: () => fileOk(page, lc2, nm) }); }
        } else if (key === 'cover_letter_file') {
          const cl = isProvided(answers.cover_letter_path) ? answers.cover_letter_path!.trim() : (ctx.letterPdf ?? null);   // your own file wins; otherwise the generated PDF
          if (!cl) blank('Cover letter upload', 'no generated letter and no cover_letter_path in answers.json (the note is saved to prepared/ instead)', 'empty');
          else if (!fs_.exists(cl)) blank('Cover letter upload', `file not found: ${cl}`, 'empty');
          else {
            await loc(c).setInputFiles(cl);
            { const lc = loc(c); redo.push({ field: 'Cover letter upload', check: () => fileOk(page, lc, path.basename(cl)), apply: () => lc.setInputFiles(cl, { timeout: 4000 }) }); }
            const shown = await fileShown(page, loc(c), path.basename(cl));
            rep.filled.push({ field: 'Cover letter upload', key, value: `${path.basename(cl)}${shown ? ' - file name shown on the form' : ''}` }); rep.letterStatus = 'attached';
            if (!shown) { rep.uncertain.push({ field: 'Cover letter upload', why: 'file is set on the input but the page does not display its name; check it' }); const lc2 = loc(c), nm = path.basename(cl); lateVis.push({ field: 'Cover letter upload', match: /does not display/, check: () => fileOk(page, lc2, nm) }); }
          }
        } else blank(field || 'file upload', 'unrecognized file upload', 'custom');
        continue;
      }
      // ---- radio / checkbox groups
      if (c.type === 'radio' || c.type === 'checkbox') {
        const gk = `${c.type}|${c.group}|${c.question}`;
        if (handledGroups.has(gk)) continue; handledGroups.add(gk);
        const members = controls.filter((x) => x.type === c.type && x.group === c.group && x.question === c.question);
        const ans = custom ?? valueFor(key, answers, ctx);
        const q = c.question || c.group || `checkbox group (${members.length} options)`;
        if (!ans) { blank(q, restricted ? legalReason : key === 'unknown' ? 'unrecognized question' : 'no answer in answers.json', restricted ? 'legal' : key === 'unknown' ? 'custom' : 'empty'); continue; }
        if (key === 'privacy_consent' && members.length === 1 && /^(yes|y|true|agree|i agree|acknowledge|acknowledged|i acknowledge)$/i.test(ans.trim())) { await loc(members[0]).check(); rep.filled.push({ field: q, key, value: 'checked (your own privacy_consent answer)' }); continue; }
        const pr = pickOption(members.map((m) => m.option), ans, restricted && !custom); const { option, uncertain } = pr;
        if (!option) { blank(q, noMatchReason(members.map((m) => m.option), ans, pr), pr.ambiguous ? 'legal' : 'matcher'); continue; }
        await loc(members.find((x) => x.option === option)!).check();
        { const lm = loc(members.find((x) => x.option === option)!); redo.push({ field: q, check: () => lm.isChecked({ timeout: 2000 }).catch(() => false), apply: () => lm.check() }); }
        rep.filled.push({ field: q, key, value: option }); if (uncertain) rep.uncertain.push({ field, why: `closest option "${option}" chosen for "${ans}"` });
        continue;
      }
      // ---- yes/no style button groups
      if (c.type === 'buttons') {
        const bk = classify(c.question); const rst = (RESTRICTED as Set<string>).has(bk); const cu = customAnswer(answers, c.question); const ans = cu ?? valueFor(bk, answers, ctx);
        if (!ans) { blank(c.question, rst ? legalReason : 'unrecognized question', rst ? 'legal' : 'custom'); continue; }
        const pr = pickOption(c.buttons!, ans, rst && !cu); const { option } = pr;
        if (!option) { blank(c.question, noMatchReason(c.buttons!, ans, pr), pr.ambiguous ? 'legal' : 'matcher'); continue; }
        await safeClick(page.locator(`[data-jr="b${(c as any).bprefix?.slice(1) ?? c.jr}-${c.buttons!.indexOf(option)}"]`), `answer button "${option}"`);
        rep.filled.push({ field: c.question, key: bk, value: option }); continue;
      }
      // ---- everything else: text / textarea / select / combobox
      if (key === 'cover_letter_text' && rep.letterStatus === 'attached') continue;            // already attached as a PDF: do not paste it twice
      if (key === 'cover_letter_text' && ctx.letterPdf && controls.some((x) => x.type === 'file' && /cover/i.test(`${x.id} ${x.name} ${x.question}`)) && !custom) continue;
      const val = custom ?? valueFor(key, answers, ctx);
      if (key === 'unknown' && !custom) { blank(field, 'unrecognized field (a custom question)', 'custom'); continue; }
      if (key === 'restricted_other' && !custom) { blank(field, 'eligibility/attestation question: only filled from a custom_answers entry you write', 'custom'); continue; }
      if (key === 'edu_start_month' || key === 'edu_start_year') { blank(field, 'education start date is not in answers.json (only graduation_date)', 'empty'); continue; }
      if (!val) { blank(field, restricted ? legalReason : key === 'note_field' ? 'no tailored note available' : 'no value in answers.json', restricted ? 'legal' : 'empty'); continue; }

      if (c.tag === 'select') {
        const pr = pickOption(c.options, val, restricted && !custom); const { option, uncertain } = pr;
        if (!option) { blank(field, noMatchReason(c.options, val, pr), pr.ambiguous ? 'legal' : 'matcher'); continue; }
        await loc(c).focus({ timeout: 4000 }); await loc(c).selectOption({ label: option }); await blurField(loc(c));
        { const ls = loc(c); touched.push({ field, loc: ls }); redo.push({ field, check: async () => (await ls.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.text ?? '', undefined, { timeout: 2000 }).catch(() => '')).trim() === option, apply: async () => { await ls.selectOption({ label: option }); } }); }
        rep.filled.push({ field, key, value: option }); if (uncertain) rep.uncertain.push({ field, why: `closest option "${option}" chosen for "${val}"` });
        continue;
      }
      if (c.role === 'combobox') {
        const input = loc(c);
        if ((key === 'city' || key === 'location') && !custom) {
          const r = await fillLocationCombobox(page, input, field, answers);
          if (!r.option) blank(field, `no matching suggestion for ${r.tried.map((t) => `"${t}"`).join(' / ')}; suggestions seen: ${[...new Set(r.seen)].slice(0, 6).join(' / ') || 'none'}. Set location_query in answers.json to the exact suggestion text you want`, 'matcher');
          else { rep.filled.push({ field, key, value: r.option }); rep.uncertain.push({ field, why: 'autocomplete field: check the chosen suggestion' }); const opt = r.option; if (await shownIn(input, opt)) redo.push({ field, check: () => shownIn(input, opt), apply: async () => { await fillLocationCombobox(page, input, field, answers); } }); }
          continue;
        }
        // react-select style: OPEN FIRST and read the real options (typing "Male" into a list of "Man / Woman" would filter to nothing), choose by fuzzy rules, then verify the shown value.
        // options are read from THIS dropdown's own container first (other widgets on the page, e.g. the phone country list, may also expose role=option); page-wide only as a fallback
        const scope = input.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " select__container ") or contains(concat(" ", normalize-space(@class), " "), " select-shell ") or contains(concat(" ", normalize-space(@class), " "), " select ")][1]');
        const readOpts = async () => {
          await page.locator('[role="option"]:visible').first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
          let o = scope.locator('[role="option"]:visible'); if (!(await o.count())) o = page.locator('[role="option"]:visible');
          return { o, texts: (await o.allInnerTexts()).map((t) => t.trim()).filter(Boolean) };
        };
        await safeClick(input, `open dropdown "${field}"`);
        let { o: opts, texts } = await readOpts();
        let typed = false;
        if (!texts.length) { await typeValue(input, val.length > 40 ? val.slice(0, 40) : val, { blur: false }); typed = true; ({ o: opts, texts } = await readOpts()); }   // async/autocomplete lists only show options after typing
        let pr = pickOption(texts, val, restricted && !custom);
        if (!pr.option && !typed && texts.length > 6) {                              // long list that did not match whole-word: narrow it by typing, then match again
          await typeValue(input, val.length > 40 ? val.slice(0, 40) : val, { blur: false }); typed = true; ({ o: opts, texts } = await readOpts()); pr = pickOption(texts, val, restricted && !custom);
        }
        const { option, uncertain } = pr;
        if (!option) { await input.fill('').catch(() => {}); await input.evaluate((el) => (el as HTMLElement).blur()).catch(() => {}); blank(field, texts.length ? noMatchReason(texts, val, pr) : `no dropdown options appeared for "${val}"`, pr.ambiguous || restricted ? 'legal' : 'matcher'); continue; }
        await safeClick(opts.filter({ hasText: option }).first(), `choose "${option}" in "${field}"`);
        await input.evaluate((el) => (el as HTMLElement).blur()).catch(() => {});   // blur closes a multi-select menu that stays open after a pick (no key presses anywhere in the apply code)
        const shown = await input.evaluate((el) => { const box = el.closest('.select__container, .select-shell, [class*="select"]') ?? el.parentElement?.parentElement; return ((box as HTMLElement | null)?.innerText ?? '') + ' ' + ((el as HTMLInputElement).value ?? ''); }).catch(() => '');
        rep.filled.push({ field, key, value: option });
        if (norm(shown).includes(norm(option))) redo.push({ field, check: () => shownIn(input, option), apply: async () => { await safeClick(input, `re-open dropdown "${field}"`); const o = page.locator('[role="option"]:visible').filter({ hasText: option }).first(); await o.waitFor({ state: 'visible', timeout: 3000 }); await safeClick(o, `re-choose "${option}" in "${field}"`); await input.evaluate((el) => (el as HTMLElement).blur()).catch(() => {}); } });
        if (!norm(shown).includes(norm(option))) { rep.uncertain.push({ field, why: `chose "${option}" but the field does not visibly show it; check it` }); lateVis.push({ field, match: /does not visibly show/, check: () => shownIn(input, option) }); }
        else if (uncertain) rep.uncertain.push({ field, why: `closest option "${option}" chosen for "${val}"` });
        continue;
      }
      await typeValue(loc(c), val);
      { const lt = loc(c); touched.push({ field, loc: lt }); redo.push({ field, check: async () => sameText(await lt.inputValue({ timeout: 2000 }).catch(() => ''), val) && !invalidWhy(await readFieldState(lt)), apply: () => typeValue(lt, val, { timeout: 4000 }) }); }
      if (key === 'note_field') rep.notePlacedInForm = true;
      if (key === 'cover_letter_text') rep.letterStatus = 'pasted';
      rep.filled.push({ field, key, value: key === 'note_field' ? '(tailored note)' : key === 'cover_letter_text' ? '(cover letter text)' : val });
      if (key === 'location' || key === 'phone') rep.uncertain.push({ field, why: key === 'phone' ? 'check phone format / country code' : 'check location format' });
    } catch (e) {
      blank(field, `error: ${(e as Error).message.split('\n')[0].slice(0, 120)}`, 'matcher');
    }
  }
  // RECONCILE: re-read everything we filled; re-apply whatever the page cleared; repeat until stable (max 3 passes). Nothing is trusted until it is re-read.
  for (let pass = 1; pass <= 3; pass++) {
    let wiped = 0;
    for (const r of redo) {
      if (process.env.JR_DEBUG_FILL) console.error(`[debug ${new Date().toISOString().slice(14, 23)}] reconcile pass ${pass}: checking ${r.field}`);
      if (await r.check()) continue;
      if (process.env.JR_DEBUG_FILL) console.error(`[debug] WIPED: ${r.field}`);
      wiped++; if (!rep.reapplied.includes(r.field)) rep.reapplied.push(r.field);
      try { await r.apply(); } catch (e) { /* the final VERIFY reports what is still empty */ }
    }
    if (!wiped) break;
  }
  // FORM-STATE VERIFY: a control that shows text but that the form still marks invalid / required / out of sync with its own state is NOT filled. Retype once (real keystrokes), then report by label.
  for (const t of touched) {
    let why = invalidWhy(await readFieldState(t.loc));
    if (why) { const v = rep.filled.find((f) => f.field === t.field)?.value; if (v && !/^\(/.test(v)) { await typeValue(t.loc, v, { timeout: 4000 }).catch(() => {}); why = invalidWhy(await readFieldState(t.loc)); } }
    if (!why) continue;
    const i = rep.filled.findIndex((f) => f.field === t.field); if (i >= 0) rep.filled.splice(i, 1);
    rep.unregistered!.push({ field: t.field, why }); rep.blank.push({ field: t.field, reason: `NOT FILLED: it shows text but ${why}`, cause: 'matcher', required: true });
  }
  for (const lv of lateVis) if (await lv.check()) rep.uncertain = rep.uncertain.filter((u) => !(u.field === lv.field && lv.match.test(u.why)));
  // Some forms only create the file input after an "Attach" button is clicked (native file chooser). Handle that for the resume when no file input exists.
  if (!controls.some((x) => x.type === 'file') && ctx.resumePath && fs_.exists(ctx.resumePath)) {
    const btn = page.locator('button:visible, [role="button"]:visible, label:visible').filter({ hasText: /^\s*(attach|upload|choose file|select file|attach resume|upload resume)/i }).first();
    if (await btn.count()) {
      try {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 4000 }), safeClick(btn, 'open file chooser (Attach)')]);
        await chooser.setFiles(ctx.resumePath); const shown = await page.getByText(path.basename(ctx.resumePath)).first().isVisible({ timeout: 3000 }).catch(() => false);
        rep.filled.push({ field: 'Resume upload', key: 'resume', value: `${ctx.resumePath} (via the Attach file chooser)${shown ? ' - file name shown on the form' : ''}` });
        if (!shown) rep.uncertain.push({ field: 'Resume upload', why: 'chosen through the file chooser but the page does not display the name; check it' });
        T.resume.push({ jr: -1, tag: 'chooser', type: 'chooser', id: '', name: '', role: '', question: 'Resume', option: '', options: [], group: '', required: false });
      } catch (e) { blank('Resume upload', `Attach button found but the file chooser failed: ${(e as Error).message.split('\n')[0].slice(0, 100)}`, 'matcher'); }
    }
  }
  rep.checks = await verifyEssentials(page, rep, T, ctx);
  return rep;
}

/** A file counts as attached when the input still holds it OR the page shows its name (Greenhouse clears the input after uploading and shows a file-name chip instead). */
async function fileOk(page: Page, input: Locator, name: string): Promise<boolean> {
  if (await input.evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0) > 0, undefined, { timeout: 1500 }).catch(() => false)) return true;
  return page.getByText(name, { exact: false }).first().isVisible({ timeout: 1000 }).catch(() => false);
}
/** True when the page shows the uploaded file's name (or, failing that, the input itself holds the file and the name is somewhere in the visible text). */
async function fileShown(page: Page, input: Locator, name: string): Promise<boolean> {
  const held = await input.evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0) > 0, undefined, { timeout: 2000 }).catch(() => false);
  if (!held) return false;
  return page.getByText(name, { exact: false }).first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
}

/** END-OF-RUN VERIFY: re-read the live form and report, for each essential, filled or MISSING (with the reason). Independent of what the fill step believed. */
export async function verifyEssentials(page: Page, rep: FillReport, T: Record<CheckItem, Ctl[]>, ctx: FillCtx): Promise<Check[]> {
  const out: Check[] = [];
  const whyItem = (item: CheckItem, cs: Ctl[]) => { const re = item === 'resume' ? /^Resume upload/ : item === 'cover letter' ? /^Cover letter/ : null; const hit = re ? rep.blank.find((b) => re.test(b.field)) : null; return hit ? hit.reason : why(cs); };
  const why = (cs: Ctl[]) => { const lab = (c: Ctl) => (c.question || c.name || c.id).replace(/\*|✱/g, '').replace(/\s+/g, ' ').trim().slice(0, 110); const hit = rep.blank.find((b) => cs.some((c) => lab(c) === b.field)); return hit ? hit.reason : 'the value was typed but the field is empty when re-read'; };
  const readAll = async (cs: Ctl[]) => Promise.all(cs.map(async (c) => {
    const l = page.locator(`[data-jr="${c.jr}"]`);
    if (c.type === 'chooser') return true;
    if (c.type === 'file') { const nm = /cover/i.test(`${c.id} ${c.name} ${c.question}`) ? (ctx.letterPdf ? path.basename(ctx.letterPdf) : '') : (ctx.resumePath ? path.basename(ctx.resumePath) : ''); return nm ? fileOk(page, l, nm) : l.evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0) > 0, undefined, { timeout: 1500 }).catch(() => false); }
    return (await l.inputValue({ timeout: 2000 }).catch(() => '')).trim().length > 0 && !invalidWhy(await readFieldState(l));   // text that the form's own state rejects is not filled
  }));
  for (const item of ['name', 'email', 'phone'] as const) {
    const cs = T[item];
    if (!cs.length) { out.push(item === 'phone' ? { item, status: 'n/a', detail: 'the form has no phone field' } : { item, status: 'MISSING', detail: `no ${item} field was recognized on this form` }); continue; }
    const ok = await readAll(cs);
    out.push(ok.every(Boolean) ? { item, status: 'filled', detail: `${cs.length} field(s) re-read, all non-empty` } : { item, status: 'MISSING', detail: why(cs.filter((_, i) => !ok[i])) });
  }
  const res = T.resume;
  if (!res.length) out.push({ item: 'resume', status: 'n/a', detail: 'the form has no resume upload' });
  else { const ok = await readAll(res); out.push(ok.every(Boolean) ? { item: 'resume', status: 'filled', detail: 'file present on the input or its name is shown on the page' } : { item: 'resume', status: 'MISSING', detail: whyItem('resume', res) }); }
  const cl = T['cover letter'];
  const letterReason = ctx.letterWhy || 'no reason was recorded';
  if (cl.length) {
    const ok = await readAll(cl);
    if (ok.some(Boolean)) out.push({ item: 'cover letter', status: 'filled', detail: rep.letterStatus === 'attached' ? 'PDF attached' : 'text pasted' });
    else out.push({ item: 'cover letter', status: ctx.letterSkipped ? 'skipped' : 'MISSING', detail: ctx.letterSkipped ? 'skipped by --no-letter' : ctx.letter ? whyItem('cover letter', cl) : `the form has a cover letter field but no letter was generated: ${letterReason}` });
  } else if (ctx.letter) out.push({ item: 'cover letter', status: 'n/a', detail: 'the form has no cover letter field; the letter is saved in prepared/' });
  else out.push({ item: 'cover letter', status: ctx.letterSkipped ? 'skipped' : 'MISSING', detail: ctx.letterSkipped ? 'skipped by --no-letter' : `no letter was generated: ${letterReason}` });
  return out;
}

/** "filled X of Y fields; blank because you left it empty: N; ..." */
export function completeness(rep: FillReport, letterWhy?: string): string {
  const n = (c: Cause) => rep.blank.filter((b) => b.cause === c).length;
  return `Prefill completeness: filled ${rep.filled.length} of ${rep.filled.length + rep.blank.length} fields; blank because you left it empty in answers.json: ${n('empty')}; legal/attestation left blank by rule: ${n('legal')}; custom/unrecognized questions: ${n('custom')}; matcher missed (option mismatch or widget error): ${n('matcher')}; cover letter: ${rep.letterStatus === 'none' ? `none generated (${letterWhy || 'reason not recorded'})` : rep.letterStatus}`;
}
