import fs from 'node:fs';
import { AnswersSchema, isProvided } from './answers.js';

// npm run answers:todo — what to write into answers.json, from the file itself plus the blank questions logged by past prefills.
const file = process.argv[2] ?? 'answers.json';
if (!fs.existsSync(file)) { console.error(`${file} not found. Copy answers.example.json to ${file} and fill it in (it is gitignored).`); process.exit(1); }
const a = AnswersSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
const A = (a.answers ?? {}) as Record<string, string | null | undefined>;
const top = a as unknown as Record<string, string | null | undefined>;
const L: string[] = [];
const section = (t: string) => L.push('', `== ${t}`);

section('1. Values still REPLACE_ME / empty in the identity part (never invented)');
const idKeys: [string, string][] = [['degree', 'e.g. "Bachelor of Science" (school forms with a degree dropdown need the exact option text)'], ['major', 'e.g. "Computer Science" / "Mathematics"'], ['preferred_name', 'only if you want one typed'], ['address', 'full street address, only needed when a form asks for one'], ['location_query', 'exact autocomplete text for city fields, e.g. "New York, New York, United States"'], ['twitter', 'optional'], ['current_company', 'optional (e.g. Example Labs if you want it shown)'], ['cover_letter_path', 'your own cover-letter file, if you want uploads filled']];
for (const [k, why] of idKeys) if (!isProvided(top[k])) L.push(`  ${k}: ${why}`);
for (const k of ['name', 'first_name', 'last_name', 'email', 'phone', 'city', 'state', 'linkedin', 'github', 'portfolio', 'school', 'graduation_date']) if (!isProvided(top[k])) L.push(`  ${k}: REQUIRED, not set`);
L.push('  NOTE first_name/last_name are typed exactly as written in answers.json. If you only set "name", check how it is split and confirm it matches how you want them typed.');

section('2. Standing answers (YOU write these once; they are used verbatim and must equal an option on the form to be selected)');
const std: [string, string][] = [['how_did_you_hear', 'e.g. "LinkedIn"'], ['salary_expectation', 'free text, e.g. "$115,000+"; many forms ask'], ['start_date', 'e.g. "June 2027"']];
for (const [k, why] of std) if (!isProvided(A[k])) L.push(`  answers.${k}: ${why}`);

section('3. Legal / attestation / demographic (left BLANK by rule until you write the exact answer; the tool never guesses)');
const legal: [string, string][] = [['work_authorization', 'your literal answer to "authorized to work in the US?" (e.g. "Yes")'], ['sponsorship_needed', 'your literal answer to "require sponsorship now or in the future?" (e.g. "No")'], ['eeo_gender', 'exact option text, or "Decline To Self Identify"'], ['eeo_race', 'exact option text, or decline'], ['eeo_hispanic', 'Yes / No / decline'], ['eeo_orientation', 'exact option text, or decline'], ['eeo_transgender', 'Yes / No / decline'], ['veteran', 'exact option text'], ['disability', 'exact option text'], ['criminal_history', 'only if you want it answered'], ['pronouns', 'optional'], ['previously_employed', 'answer to "worked here before?"'], ['privacy_consent', 'write "Yes" only if you want privacy/consent boxes ticked for you']];
for (const [k, why] of legal) if (!isProvided(A[k])) L.push(`  answers.${k}: ${why}`);

section('4. Custom questions that came up blank in past prefills (add a custom_answers entry for any you want auto-answered)');
const log = 'prepared/blank-questions.jsonl';
if (fs.existsSync(log)) {
  const counts = new Map<string, { n: number; cause: string; cos: Set<string> }>();
  for (const l of fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)) { const r = JSON.parse(l); if (!['custom', 'matcher', 'empty'].includes(r.cause)) continue; const k = r.field.toLowerCase().replace(/\s+/g, ' ').slice(0, 90); const e = counts.get(k) ?? { n: 0, cause: r.cause, cos: new Set() }; e.n++; e.cos.add(r.company); counts.set(k, e); }
  const rows = [...counts.entries()].filter(([, e]) => e.cause === 'custom').sort((x, y) => y[1].n - x[1].n);
  if (!rows.length) L.push('  (none logged)');
  for (const [q, e] of rows) L.push(`  seen ${e.n}x at ${[...e.cos].join(', ')}: "${q}"`);
  L.push('', '  stub to paste into "custom_answers" (edit the answers; delete entries you do not want):');
  for (const [q] of rows.slice(0, 8)) L.push(`    { "match": ${JSON.stringify(q.slice(0, 50))}, "answer": "WRITE YOUR OWN ANSWER" },`);
} else L.push('  (no prefill log yet)');
console.log(L.join('\n'));
