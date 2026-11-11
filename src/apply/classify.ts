/** Maps a question/field label to a canonical key. Pure; no browser. */
export type Key =
  | 'first_name' | 'last_name' | 'full_name' | 'preferred_name' | 'email' | 'phone' | 'location' | 'city' | 'state' | 'country'
  | 'full_address' | 'twitter' | 'linkedin' | 'github' | 'portfolio' | 'website' | 'school' | 'degree' | 'major' | 'current_company'
  | 'edu_end_month' | 'edu_end_year' | 'edu_start_month' | 'edu_start_year'
  | 'resume' | 'cover_letter_file' | 'cover_letter_text' | 'note_field'
  | 'how_did_you_hear' | 'salary_expectation' | 'start_date'
  | 'work_authorization' | 'sponsorship_needed' | 'eeo_gender' | 'eeo_race' | 'eeo_hispanic' | 'eeo_orientation' | 'eeo_transgender' | 'privacy_consent' | 'veteran' | 'disability' | 'criminal_history' | 'pronouns' | 'previously_employed'
  | 'restricted_other' | 'unknown';

/** Keys whose answers are legal / attestation / demographic: filled ONLY from an exact owner-written answer. Never inferred, never defaulted. */
export const RESTRICTED: ReadonlySet<Key> = new Set<Key>(['work_authorization', 'sponsorship_needed', 'eeo_gender', 'eeo_race', 'eeo_hispanic', 'eeo_orientation', 'eeo_transgender', 'privacy_consent', 'veteran', 'disability', 'criminal_history', 'pronouns', 'previously_employed', 'restricted_other']);

const rules: [Key, RegExp][] = [
  // restricted first so e.g. "authorized to work" is never mistaken for something benign
  ['sponsorship_needed', /sponsor/i],
  ['work_authorization', /authori[sz](ed|ation)\s+to\s+work|work\s+authori[sz]ation|legally\s+(authori[sz]ed|eligible|permitted)|eligible\s+to\s+work|right\s+to\s+work|employment\s+eligibility/i],
  ['eeo_transgender', /transgender|trans\b/i],
  ['eeo_orientation', /sexual\s+orientation|lgbtq/i],
  ['privacy_consent', /by\s+submitting|i\s+acknowledge|i\s+have\s+read\s+and\s+(understand|agree)|privacy\s+(notice|policy|statement)|i\s+(agree|consent)\b|terms\s+(and|&)\s+conditions/i],
  ['restricted_other', /(currently\s+)?(based|located|reside|residing)\s+in\s+(any|one)\s+of\s+(these|the\s+following)\s+countries|based\s+in\s+any\s+of\s+these\s+countries/i],
  ['eeo_hispanic', /hispanic|latin[oax]/i],
  ['eeo_race', /\brace\b|ethnic/i],
  ['eeo_gender', /gender|\bsex\b/i],
  ['veteran', /veteran|military|armed forces/i],
  ['disability', /disab/i],
  ['criminal_history', /criminal|convict|felony|misdemeanor|background check/i],
  ['pronouns', /\bpronouns?\b(?!\s*(?:ciation|unc))|your\s+pronouns|preferred\s+pronouns/i],   // "How do you pronounce your name?" is NOT a pronouns question
  ['previously_employed', /previously\s+(been\s+)?employed|former\s+(employee|intern)|worked\s+(for|at)\s+.*(before|previously)|ever\s+(been\s+)?employed/i],
  ['restricted_other', /citizen|clearance|visa\b|immigration|nationality|date of birth|birth\s?date|social security|\bssn\b|\bage\b.*(18|over)|\b18\b.*years/i],
  ['cover_letter_file', /cover\s*letter.*(attach|upload|file)|attach.*cover\s*letter/i],
  ['cover_letter_text', /cover\s*letter/i],
  ['note_field', /why\s+(do\s+you\s+want|are\s+you\s+(interested|excited)|us\b|this\s+(company|role)|\w+\?)|what\s+(interests|excites|draws)\s+you|motivation|tell\s+us\s+about\s+yourself|interest\s+in\s+(this|our)/i],
  ['resume', /\bresume\b|\bcv\b|curriculum/i],
  ['how_did_you_hear', /how\s+did\s+you\s+(first\s+)?(hear|learn|find)|where\s+did\s+you\s+(first\s+)?(hear|find|learn)|(hear|learn)\s+about\s+(us|this|the|our)\b|referral\s+source|\bsource\b/i],
  ['salary_expectation', /salary|compensation\s+expectation|desired\s+(pay|compensation)|pay\s+expectation/i],
  ['start_date', /(earliest\s+)?start\s+date(?!\s+(month|year))|when\s+(can|could)\s+you\s+start|available\s+to\s+start|notice\s+period/i],
  ['edu_start_month', /start\s+date\s+month/i], ['edu_start_year', /start\s+date\s+year/i],
  ['edu_end_month', /(end|graduation)\s+date\s+month/i], ['edu_end_year', /(end|graduation)\s+date\s+year/i],
  ['full_address', /full\s+address|street\s+address|mailing\s+address|home\s+address|address\s+line|residential\s+address/i],
  ['twitter', /twitter|\bx\s+(handle|profile)|x\.com/i],
  ['linkedin', /linked\s?in/i], ['github', /git\s?hub/i],
  ['portfolio', /portfolio/i], ['website', /\bwebsite\b|personal\s+(site|url)|other\s+links?|\bblog\b/i],
  ['school', /(?<!post[ -])(?<!work[ -])(?:\bschool\b|university|college|institution)(?!\s+(?:work|experience))/i], ['degree', /\bdegree\b/i], ['major', /discipline|\bmajor\b|field\s+of\s+study/i],
  ['current_company', /current\s+(company|employer)|\bemployer\b|\bcompany\b(?!.*(want|work|about))/i],
  ['preferred_name', /preferred\s+(first\s+)?name|nickname/i],
  ['unknown', /pronunciation|pronounce/i],   // "Name Pronunciation | How do you pronounce your name?" is a free-text question of its own: never the name, never the pronouns
  ['first_name', /\b(?:legal\s+)?first\s+name\b|given\s+name/i], ['last_name', /\b(?:legal\s+)?last\s+name\b|family\s+name|surname/i],
  ['full_name', /^\s*(legal\s+)?(full\s+)?name\b/i],
  ['email', /e-?mail/i], ['phone', /phone|mobile|\btel\b/i],
  ['state', /\bstate\b|province/i], ['country', /\bcountry\b/i], ['city', /^\s*city\b|\(city\)/i],
  ['location', /location|where\s+are\s+you\s+(based|located)|\bresid(e|ence)\b|city,?\s*state/i],
];

export function classify(labelText: string): Key {
  const t = (labelText ?? '').replace(/\s+/g, ' ').replace(/\*|✱/g, '').trim();
  if (!t) return 'unknown';
  for (const [k, re] of rules) if (re.test(t)) return k;
  return 'unknown';
}
