#!/bin/zsh
# job-radar daily run (launchd calls this at 7:30 New York time; see `npm run schedule:print`).
# Order: 1) ingest job-alert emails (only if IMAP is configured in .env), 2) scan: company boards + public feeds, score everything pending, write the digest.
# Spend: every LLM call goes through budgetedLlm, so the monthly cap in data/spend.json stops scoring at the cap; unscored jobs wait for the next run.
# Approval: the scan refuses to score until data/.cost_ok exists (created once by a manual `npm run scan -- --yes`); this script never passes --yes.
set -u
cd "${0:A:h}/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p data/logs
log="data/logs/daily-$(date +%F).log"
{
  echo "=== $(date '+%F %T %Z') job-radar daily"
  if grep -qE '^IMAP_APP_PASSWORD=.+' .env 2>/dev/null; then
    echo "--- ingest:email"; npm run -s ingest:email -- --imap --since 2d || echo "!! ingest failed (exit $?)"
  else
    echo "--- ingest:email skipped (no IMAP_APP_PASSWORD in .env)"
  fi
  echo "--- scan + digest"; npm run -s scan -- --feeds || echo "!! scan failed (exit $?)"
  echo "=== done $(date '+%T')"
} >> "$log" 2>&1
