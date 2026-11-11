import fs from 'node:fs';
import { politeFetch } from '../http.js';
import { greenhouseUrl } from '../adapters/greenhouse.js';
import { leverUrl } from '../adapters/lever.js';
import { ashbyUrl } from '../adapters/ashby.js';
import type { Ats, Company } from '../types.js';
import { loadCompanies, companiesWritePath } from '../userconfig.js';

// usage: npm run discover -- greenhouse:stripe lever:plaid ashby:ramp  (or "Name=ats:slug")
const urls: Record<Ats, (s: string) => string> = { greenhouse: greenhouseUrl, lever: leverUrl, ashby: ashbyUrl };
const file = companiesWritePath();   // writes the real (gitignored) companies.json, seeded from the example when it does not exist yet
const companies: Company[] = loadCompanies();
let added = 0;
if (!process.argv.slice(2).length) { console.error('usage: npm run discover -- greenhouse:stripe lever:plaid ashby:ramp   (or "Name=ats:slug")'); process.exit(1); }
for (const arg of process.argv.slice(2)) {
  const [maybeName, rest] = arg.includes('=') ? arg.split('=') : [undefined, arg];
  const [ats, slug] = rest.split(':') as [Ats, string];
  if (!urls[ats] || !slug) { console.log(`skip (bad format): ${arg}`); continue; }
  if (companies.some((c) => c.ats === ats && c.slug === slug)) { console.log(`already have ${ats}:${slug}`); continue; }
  try {
    const res = await politeFetch(urls[ats](slug), { retries: 1 });
    if (res.status === 200) {
      companies.push({ name: maybeName ?? slug, ats, slug, tags: [] });
      added++;
      console.log(`200 ${ats}:${slug} -> kept`);
    } else console.log(`${res.status} ${ats}:${slug} -> dropped`);
  } catch (e) { console.log(`error ${ats}:${slug} -> dropped (${(e as Error).message})`); }
}
fs.writeFileSync(file, JSON.stringify(companies, null, 2) + '\n');
console.log(`added ${added}; total ${companies.length}`);
