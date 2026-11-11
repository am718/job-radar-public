import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Company } from './types.js';

/**
 * Everything personal lives in gitignored files at the repo root (profile.json, companies.json, job-radar.config.json).
 * Each has a committed *.example.json describing an invented candidate. Resolution order for a user file:
 *   1. environment override (JOB_RADAR_CONFIG / JOB_RADAR_PROFILE / JOB_RADAR_COMPANIES), resolved against the cwd
 *   2. the real file in the repo root
 *   3. the committed example next to it
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type UserFileName = 'profile' | 'companies' | 'config';
const FILES: Record<UserFileName, { real: string; example: string; env: string }> = {
  profile: { real: 'profile.json', example: 'profile.example.json', env: 'JOB_RADAR_PROFILE' },
  companies: { real: 'companies.json', example: 'companies.example.json', env: 'JOB_RADAR_COMPANIES' },
  config: { real: 'job-radar.config.json', example: 'job-radar.config.example.json', env: 'JOB_RADAR_CONFIG' },
};

/** Absolute path of the file that will be read for `name` (env override -> real file -> example). */
export function resolveUserFile(name: UserFileName): string {
  const f = FILES[name];
  const ov = process.env[f.env];
  if (ov) return path.resolve(ov);
  const real = path.join(ROOT, f.real);
  return fs.existsSync(real) ? real : path.join(ROOT, f.example);
}

export function loadUserFile<T = unknown>(name: UserFileName): T {
  return JSON.parse(fs.readFileSync(resolveUserFile(name), 'utf8')) as T;
}

// ---- main config (preferences) ----
const TierRule = z.object({
  tier: z.number().int().min(1),
  label: z.string(),
  /** Regex sources (case-insensitive) matched against the job location. Ignored when `remote` is true. */
  patterns: z.array(z.string()).default([]),
  /** The remote tier: matches remote jobs unless the location names a non-US place without a US hint. */
  remote: z.boolean().optional(),
});
export const ConfigSchema = z.object({
  minBasePay: z.number(),
  requiresSponsorship: z.boolean().nullable().default(null),
  trackAKeywords: z.array(z.string()),
  trackBKeywords: z.array(z.string()),
  excludeTitleWords: z.array(z.string()),
  excludeDescriptionPatterns: z.array(z.string()),
  softWords: z.array(z.string()),
  hardWords: z.array(z.string()),
  /** Checked in ascending tier order; the first match wins. A job matching none is dropped ("location dropped"). */
  locationTiers: z.array(TierRule),
  /** Tiers whose jobs are dropped when the base pay is unlisted. `reason` is stored as the filter reason. */
  listedPayRequired: z.array(z.object({ tier: z.number().int(), reason: z.string() })).default([]),
});
export type UserConfig = z.infer<typeof ConfigSchema>;

let cached: { file: string; cfg: UserConfig } | null = null;
export function loadConfig(): UserConfig {
  const file = resolveUserFile('config');
  if (cached?.file === file) return cached.cfg;
  const cfg = ConfigSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  cached = { file, cfg };
  return cfg;
}

// ---- companies ----
/** companies.json when present (or the env override), else companies.example.json. */
export function loadCompanies(): Company[] {
  return loadUserFile<Company[]>('companies');
}
/** Where `discover`/`--add` should WRITE: the env override or the real companies.json (never the example). */
export function companiesWritePath(): string {
  return process.env.JOB_RADAR_COMPANIES ? path.resolve(process.env.JOB_RADAR_COMPANIES) : path.join(ROOT, 'companies.json');
}

// ---- profile ----
export interface Profile {
  name?: string; summary: string; resume_A?: string; resume_B?: string; goal?: string;
  /** Rendered into the scoring prompts, e.g. "June 2027". */
  graduation?: string;
  /** Rendered into the scoring prompts after "The candidate has real ...", e.g. "internship and project work". */
  experience_note?: string;
  [k: string]: unknown;
}
export function loadProfileFile(): Profile { return loadUserFile<Profile>('profile'); }
