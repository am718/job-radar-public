import type { Job } from './types.js';
import { loadConfig } from './userconfig.js';

export type Tier = number;
const REMOTE = /\bremote\b/i;
const NON_US = /\b(canada|uk|united kingdom|london|germany|berlin|india|ireland|dublin|france|paris|singapore|australia|brazil|mexico|emea|apac|europe|latam|toronto|japan|tokyo|poland|spain|netherlands|sweden|norway|denmark|finland|italy|portugal|switzerland|austria|belgium|israel|china|korea|argentina|colombia|chile|uae|dubai|south africa|new zealand|philippines|vietnam|turkey|romania|czech|lithuania|estonia)\b/i;
const US_HINT = /\b(us|usa|united states|u\.s\.)\b/i;

import type { UserConfig } from './userconfig.js';

/** Builds a tier classifier from the config's locationTiers (lowest tier first, first match wins). Exported so tests can try other configs. */
export function makeLocationTier(tiers: UserConfig['locationTiers']) {
  const rules = tiers
    .map((t) => ({ tier: t.tier, remote: !!t.remote, res: (t.patterns ?? []).map((p) => new RegExp(p, 'i')) }))
    .sort((a, b) => a.tier - b.tier);
  return function locationTier(job: Pick<Job, 'location' | 'pay' | 'remote'>): Tier | null {
    const loc = job.location || '';
    const remote = job.remote || REMOTE.test(loc);
    for (const r of rules) {
      if (r.remote) { if (remote && !(NON_US.test(loc) && !US_HINT.test(loc))) return r.tier; }
      else if (r.res.some((re) => re.test(loc))) return r.tier;
    }
    return null;   // no tier matched: the job is dropped ("location dropped")
  };
}

/** Tier 1-N per job-radar.config.json locationTiers, or null when the job must be dropped. */
export const locationTier = makeLocationTier(loadConfig().locationTiers);
