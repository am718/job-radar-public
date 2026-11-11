import fs from 'node:fs';
import { z } from 'zod';

/** Placeholders and empty strings count as "not provided": they are NEVER typed into a form. */
export const isProvided = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !/^(REPLACE|FILL|TODO|CHANGE)[ _-]?ME|^<.*>$|^\.\.\.$/i.test(v.trim());

const s = z.string().nullable().optional();
export const AnswersSchema = z.object({
  name: s, first_name: s, last_name: s, preferred_name: s, email: s, phone: s, city: s, state: s, country: s,
  linkedin: s, github: s, portfolio: s, website: s, twitter: s,
  address: s,                 // full street address, only if a form asks for it
  location_query: s,          // exact text for location autocompletes, e.g. "New York, New York, United States"
  cover_letter_path: s,       // your own cover-letter file; uploaded only if you set it
  school: s, degree: s, major: s, graduation_date: s,                       // graduation_date: "YYYY-MM"
  current_company: s,
  resumes: z.object({ A: s, B: s }).partial().optional(),                    // paths, e.g. resumes/resume-A.pdf
  // Per-question answers the owner writes himself. Legal / attestation answers are used ONLY if present here, verbatim.
  answers: z.object({
    work_authorization: s, sponsorship_needed: s, how_did_you_hear: s, salary_expectation: s, start_date: s,
    eeo_gender: s, eeo_race: s, eeo_hispanic: s, eeo_orientation: s, eeo_transgender: s, veteran: s, disability: s, criminal_history: s, pronouns: s, previously_employed: s, privacy_consent: s,
  }).partial().optional(),
  // Free-form: [{ "match": "text or /regex/i", "answer": "exact answer" }] for any other question. Used only when the owner writes it.
  custom_answers: z.array(z.object({ match: z.string(), answer: z.string() })).optional(),
}).strict();
export type Answers = z.infer<typeof AnswersSchema>;

export function loadAnswers(file = 'answers.json'): Answers {
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Copy answers.example.json to answers.json and fill it in (it is gitignored).`);
  return AnswersSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
