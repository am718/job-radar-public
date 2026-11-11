# Scheduling (7:30am America/New_York)

launchd (macOS): launchd's StartCalendarInterval uses the machine's local time zone, so this fires at 7:30 only if the Mac is set to Eastern time (the plist's TZ variable only affects the job's environment, not the trigger).

    sed "s#REPLACE_WITH_ABSOLUTE_PATH#$(dirname "$PWD")#" schedule/com.jobradar.scan.plist > ~/Library/LaunchAgents/com.jobradar.scan.plist
    launchctl load ~/Library/LaunchAgents/com.jobradar.scan.plist

cron (crontab -e):

    CRON_TZ=America/New_York
    30 7 * * * cd /ABSOLUTE/PATH/job-radar && /usr/local/bin/npm run scan >> scan.log 2>&1

Note: `CRON_TZ` is honored by some crons (cronie) but NOT by macOS cron; on macOS use launchd with the Mac in Eastern time. Scheduled runs need `data/.cost_ok` (created by the first `npm run scan -- --yes`). The plist/cron lines are UNTESTED here: nothing was installed.
