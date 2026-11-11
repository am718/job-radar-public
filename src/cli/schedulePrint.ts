import fs from 'node:fs';
import path from 'node:path';
// Prints (never runs) the exact commands to install / uninstall the daily launchd job on this Mac. Nothing is installed by this script.
export function scheduleCommands(repo: string, uid = '$(id -u)', tz = '') {
  const plist = '~/Library/LaunchAgents/com.jobradar.daily.plist', q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `# job-radar daily job: 7:30 every day in this Mac's time zone${tz ? ` (currently ${tz}${/New_York/.test(tz) ? ', which is New York time' : ': set it to America/New_York first'})` : ''}`,
    '# runs schedule/daily.sh: ingest alert emails (if IMAP is set in .env), then scan boards + feeds, score within the monthly cap, write the digest. Log: data/logs/',
    '', '# INSTALL', `mkdir -p ${q(path.join(repo, 'data/logs'))}`,
    `sed "s#REPLACE_WITH_ABSOLUTE_PATH#${repo.replace(/"/g, '\\"')}#g" ${q(path.join(repo, 'schedule/com.jobradar.daily.plist'))} > ${plist}`,
    `launchctl bootstrap gui/${uid} ${plist}`,
    '', '# CHECK / RUN ONCE NOW', `launchctl print gui/${uid}/com.jobradar.daily | head -20`, `launchctl kickstart gui/${uid}/com.jobradar.daily`,
    '', '# UNINSTALL', `launchctl bootout gui/${uid}/com.jobradar.daily`, `rm ${plist}`,
  ].join('\n');
}
if (process.argv[1]?.endsWith('schedulePrint.ts')) {
  let tz = ''; try { tz = fs.readlinkSync('/etc/localtime').replace(/^.*zoneinfo\//, ''); } catch { /* not macOS */ }
  console.log(scheduleCommands(process.cwd(), '$(id -u)', tz));
}
