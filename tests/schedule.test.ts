import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scheduleCommands } from '../src/cli/schedulePrint.js';

describe('daily schedule (printed, never installed by the tool)', () => {
  it('prints install, check and uninstall commands for the daily job with the repo path filled in', () => {
    const out = scheduleCommands('/Users/someone/job-radar', '$(id -u)', 'America/New_York');
    expect(out).toMatch(/launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/com\.jobradar\.daily\.plist/);
    expect(out).toMatch(/launchctl bootout gui\/\$\(id -u\)\/com\.jobradar\.daily/);
    expect(out).toMatch(/sed "s#REPLACE_WITH_ABSOLUTE_PATH#\/Users\/someone\/job-radar#g"/); expect(out).toMatch(/New York time/);
    expect(scheduleCommands('/x', '501', 'Europe/Paris')).toMatch(/set it to America\/New_York first/);
  });
  it('the plist runs schedule/daily.sh at 7:30 and has only the path placeholder; daily.sh runs ingest then scan with feeds, never --yes', () => {
    const p = fs.readFileSync('schedule/com.jobradar.daily.plist', 'utf8');
    expect(p).toMatch(/<key>Hour<\/key><integer>7<\/integer><key>Minute<\/key><integer>30<\/integer>/); expect(p).toMatch(/REPLACE_WITH_ABSOLUTE_PATH\/schedule\/daily\.sh/); expect(p).not.toMatch(/\/Users\//);
    const sh = fs.readFileSync('schedule/daily.sh', 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');   // commands only, not comments
    expect(sh.indexOf('ingest:email')).toBeLessThan(sh.indexOf('npm run -s scan')); expect(sh).toMatch(/scan -- --feeds/); expect(sh).not.toMatch(/--yes/);
    expect(fs.readFileSync('src/cli/schedulePrint.ts', 'utf8')).not.toMatch(/execSync|spawn|child_process/);
  });
});
