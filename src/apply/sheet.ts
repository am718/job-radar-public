import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { isProvided, type Answers } from './answers.js';
import { byHandFiles } from './byfiles.js';
import { findJob } from './prepare.js';
import { cacheVersion } from '../scoring/scorer.js';
import { titleTrack } from '../prefilter.js';

// COPY-READY SHEET for applying in your own normal browser when a site rejects the automated window (captcha, bot score, 428...). It only PRINTS what you already wrote
// in answers.json plus the cover letter / note this tool already made. It opens no page, makes no request, and works around nothing: the manual path is simply a clean one.
const LABELS: Record<string, string> = {
  name: 'Full name', first_name: 'First name', last_name: 'Last name', preferred_name: 'Preferred name', email: 'Email', phone: 'Phone', city: 'City', state: 'State', country: 'Country',
  location_query: 'Location (autocomplete text)', address: 'Street address', linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Portfolio', website: 'Website', twitter: 'Twitter',
  school: 'School', degree: 'Degree', major: 'Major', graduation_date: 'Graduation (YYYY-MM)', current_company: 'Current company',
};
const ANSWER_LABELS: Record<string, string> = {
  work_authorization: 'Work authorization', sponsorship_needed: 'Sponsorship needed', how_did_you_hear: 'How did you hear about us', salary_expectation: 'Salary expectation', start_date: 'Start date',
  eeo_gender: 'Gender (EEO)', eeo_race: 'Race (EEO)', eeo_hispanic: 'Hispanic/Latino (EEO)', eeo_orientation: 'Sexual orientation (EEO)', eeo_transgender: 'Transgender (EEO)', veteran: 'Veteran status',
  disability: 'Disability status', criminal_history: 'Criminal history', pronouns: 'Pronouns', previously_employed: 'Previously employed here', privacy_consent: 'Privacy consent',
};

export function buildSheet(db: Database.Database, key: string, answers: Answers, dir?: string): string {
  const job = findJob(db, key);
  const sr = db.prepare('SELECT json FROM scores WHERE key=? AND prompt_version=?').get(job.key, cacheVersion('v3')) as { json: string } | undefined;
  const track: 'A' | 'B' = (sr ? JSON.parse(sr.json).track : titleTrack(job.title)) ?? 'A';
  const f = byHandFiles(job.key, dir);
  const read = (p: string | null) => { try { return p ? fs.readFileSync(p, 'utf8').trim() : null; } catch { return null; } };
  const L: string[] = [
    `COPY SHEET  ${job.company} - ${job.title}   (${job.key}, resume track ${track})`,
    `Apply link (open it in your own browser): ${job.url}`,
    'This sheet only prints what is in your answers.json and the files already prepared. Nothing was sent anywhere.', '',
    '--- ANSWERS (copy each into the form) ---',
  ];
  const a = answers as Record<string, any>;
  for (const [k, lab] of Object.entries(LABELS)) if (isProvided(a[k])) L.push(`${lab}: ${a[k]}`);
  L.push('', '--- QUESTION ANSWERS (only what you wrote; legal / EEO questions are never guessed) ---');
  let any = false;
  for (const [k, lab] of Object.entries(ANSWER_LABELS)) { const v = answers.answers?.[k as keyof NonNullable<Answers['answers']>]; if (isProvided(v)) { L.push(`${lab}: ${v}`); any = true; } }
  for (const c of answers.custom_answers ?? []) { L.push(`${c.match}: ${c.answer}`); any = true; }
  if (!any) L.push('(none written in answers.json)');
  const resume = answers.resumes?.[track];
  L.push('', '--- FILES TO UPLOAD ---', `Resume (track ${track}): ${isProvided(resume) ? resume : '(not set in answers.json)'}`, `Cover letter PDF: ${f.letterPdf ?? '(none yet: npm run letter -- ' + job.key + ')'}`);
  const letter = read(f.letterMd);
  L.push('', '--- COVER LETTER TEXT (paste) ---', letter ?? '(no letter text yet: run  npm run letter -- ' + job.key + ')');
  const note = read(f.note);
  if (note) L.push('', '--- TAILORED NOTE (for a "why us" / additional-information field) ---', note);
  return L.join('\n');
}
