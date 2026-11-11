import { loadConfig } from './userconfig.js';

export const MODEL = 'claude-sonnet-5-5';
export const USER_AGENT = 'job-radar/0.1 (personal job scanner; public ATS JSON APIs only)';

// Preferences live in job-radar.config.json (gitignored; falls back to job-radar.config.example.json). See src/userconfig.ts.
const cfg = loadConfig();

export const MIN_BASE_PAY = cfg.minBasePay; // annual USD BASE salary (not bonus/equity/commission/OTE); applies to ALL location tiers
export const REQUIRES_SPONSORSHIP: boolean | null = cfg.requiresSponsorship; // null => not used as a filter

export const TRACK_A_KEYWORDS = cfg.trackAKeywords;
export const TRACK_B_KEYWORDS = cfg.trackBKeywords;
export const EXCLUDE_TITLE_WORDS = cfg.excludeTitleWords;
/** Regexes (case-insensitive) matched against the description. */
export const EXCLUDE_DESCRIPTION_PATTERNS = cfg.excludeDescriptionPatterns;

/** A years-of-experience match is NOT disqualifying when its own sentence says one of these and none of the HARD words. */
export const SOFT_WORDS = cfg.softWords;
export const HARD_WORDS = cfg.hardWords;

export const DESCRIPTION_CHAR_LIMIT = 6000;
export const DIGEST_SIZE = 15;
export const DB_PATH = 'data/jobs.db';
