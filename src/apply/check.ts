import fs from 'node:fs';
import { isProvided } from './answers.js';

// npm run answers:check [file]  — every null / placeholder field in answers.json, plus every REQUIRED field the last prepared form(s) had no answer for.
// Exit 0 when the essentials (name, email, phone, a resume path) are provided and no required field was left blank last run; exit 1 otherwise.
const OPTIONAL = new Set(['preferred_name', 'address', 'website', 'twitter', 'current_company', 'cover_letter_path', 'location_query']);
export function checkAnswers(a: Record<string, any>) {
  const nulls: string[] = [], essentials: string[] = [];
  const need = (k: string, v: unknown, scope = '') => { if (!isProvided(v)) { (scope === '' && ['name', 'first_name', 'last_name', 'email', 'phone'].includes(k) ? essentials : nulls).push(`${scope}${k}`); } };
  for (const [k, v] of Object.entries(a)) {
    if (k === 'resumes') { for (const t of ['A', 'B']) { const p = v?.[t]; if (!isProvided(p)) essentials.push(`resumes.${t}`); else if (!fs.existsSync(p)) essentials.push(`resumes.${t} (file not found: ${p})`); } continue; }
    if (k === 'answers') { for (const kk of ['work_authorization', 'sponsorship_needed', 'how_did_you_hear', 'salary_expectation', 'start_date', 'eeo_gender', 'eeo_race', 'eeo_hispanic', 'eeo_orientation', 'eeo_transgender', 'veteran', 'disability', 'criminal_history', 'pronouns', 'previously_employed', 'privacy_consent']) need(kk, v?.[kk], 'answers.'); continue; }
    if (k === 'custom_answers') { for (const c of v ?? []) if (!isProvided(c.answer)) nulls.push(`custom_answers[${c.match}]`); continue; }
    if (!OPTIONAL.has(k)) need(k, v); else if (!isProvided(v)) nulls.push(k + ' (optional)');
  }
  return { nulls, essentials };
}
export function lastFormRequired(log: string, windowMs = 15 * 60_000) {
  if (!fs.existsSync(log)) return { jobs: [] as string[], fields: [] as { job: string; field: string; reason: string }[] };
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) return { jobs: [], fields: [] };
  const last = Math.max(...rows.map((r) => Date.parse(r.ts)));
  const recent = rows.filter((r) => last - Date.parse(r.ts) <= windowMs);
  return { jobs: [...new Set(recent.map((r) => r.job))] as string[], fields: recent.filter((r) => r.required && r.cause !== 'custom').map((r) => ({ job: r.job as string, field: r.field as string, reason: (r.reason ?? r.cause) as string })) };
}
function main() {
  const file = process.argv[2] ?? 'answers.json';
  if (!fs.existsSync(file)) { console.error(`${file} not found. Copy answers.example.json to ${file} and fill it in (it is gitignored).`); process.exit(1); }
  const { nulls, essentials } = checkAnswers(JSON.parse(fs.readFileSync(file, 'utf8')));
  const req = lastFormRequired(`${process.env.JOB_RADAR_PREPARED ?? 'prepared'}/blank-questions.jsonl`);
  console.log(`answers:check ${file}`);
  console.log(`\nESSENTIALS missing or placeholder (${essentials.length}) - the tool cannot fill name/email/phone/resume without these:`);
  console.log(essentials.length ? essentials.map((x) => `  ! ${x}`).join('\n') : '  (all provided)');
  console.log(`\nFields that are null / empty / placeholder (${nulls.length}) - left blank on forms until you answer them:`);
  console.log(nulls.length ? nulls.map((x) => `  - ${x}`).join('\n') : '  (none)');
  console.log(`\nREQUIRED fields the last prepared form(s) had no answer for (${req.fields.length}${req.jobs.length ? `, from ${req.jobs.join(', ')}` : ', no prepare run logged yet'}):`);
  console.log(req.fields.length ? req.fields.map((f) => `  * ${f.field}  [${f.reason}]  (${f.job})`).join('\n') : '  (none)');
  process.exit(essentials.length || req.fields.length ? 1 : 0);
}
if (process.argv[1]?.endsWith('check.ts')) main();
