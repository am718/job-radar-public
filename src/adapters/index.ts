import type { BoardAts, Company, Job } from '../types.js';
import { fetchGreenhouse } from './greenhouse.js';
import { fetchLever } from './lever.js';
import { fetchAshby } from './ashby.js';
import { fetchWorkable } from './workable.js';
import { fetchSmartRecruiters } from './smartrecruiters.js';
import { fetchRecruitee } from './recruitee.js';
import { fetchBreezy } from './breezy.js';
import { fetchBamboohr } from './bamboohr.js';
import { fetchPersonio } from './personio.js';
import { fetchTeamtailor } from './teamtailor.js';
import { fetchWorkday } from './workday.js';

/** One fetcher per board ATS: (slug, display name) -> jobs. New board sources register here. */
export type BoardFetcher = (slug: string, company: string) => Promise<Job[]>;
export const BOARD_FETCHERS: Record<BoardAts, BoardFetcher> = {
  greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby,
  workable: fetchWorkable, recruitee: fetchRecruitee, breezy: fetchBreezy, bamboohr: fetchBamboohr, personio: fetchPersonio, teamtailor: fetchTeamtailor,
  smartrecruiters: fetchSmartRecruiters,   // its API's robots.txt disallows us: this throws a clear "skipped" error instead of fetching
  workday: (slug, company) => fetchWorkday(slug, company),   // read-only; Workday application forms are apply-by-hand (not in FILLABLE)
};

export function fetchCompany(c: Company): Promise<Job[]> {
  const f = BOARD_FETCHERS[c.ats];
  if (!f) return Promise.reject(new Error(`no adapter for ATS "${c.ats}" (${c.name})`));
  return f(c.slug, c.name);
}
