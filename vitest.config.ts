import { defineConfig, configDefaults } from 'vitest/config';

// Tests never read the owner's private files (profile.json, companies.json, job-radar.config.json): they use committed fixtures,
// so they behave the same on a fresh clone. Set the variables yourself to override.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'export/**', 'data/**'],   // export/ holds a copy of the repo (npm run export:public); its tests run inside it with --verify
    env: {
      JOB_RADAR_CONFIG: process.env.JOB_RADAR_CONFIG ?? 'tests/fixtures/config.test.json',
      JOB_RADAR_PROFILE: process.env.JOB_RADAR_PROFILE ?? 'tests/fixtures/profile.test.json',
      JOB_RADAR_COMPANIES: process.env.JOB_RADAR_COMPANIES ?? 'tests/fixtures/companies.test.json',
    },
  },
});
