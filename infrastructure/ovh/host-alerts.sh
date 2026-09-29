#!/usr/bin/env bash
# infrastructure/ovh/host-alerts.sh — capacity alarms every 5 minutes.
#
# Thresholds from the production audit:
#   disk > 80%  (build cache once drove the 96GB disk to 80%)
#   RAM  > 85%  available memory low
#   CPU  > 85%  sustained (5-minute load average vs cores)
# Alerts go to the system log (journal) tagged orvyn-alerts, where the
# existing log shipping picks them up. Idempotent, read-only.

set -u

DISK_PCT_MAX=80
RAM_AVAIL_MIN_MB=$(( 15615 * 15 / 100 ))   # alert when available < 15%
LOAD_MAX_PCT=85

tag='orvyn-alerts'

# Disk
disk_pct=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ "${disk_pct:-0}" -gt "$DISK_PCT_MAX" ]; then
  logger -t "$tag" "DISK ${disk_pct}% used exceeds ${DISK_PCT_MAX}% — prune build cache (host-maintenance.sh)"
fi

# Memory: available (not free) — includes reclaimable cache
avail_mb=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "${avail_mb:-99999}" -lt "$RAM_AVAIL_MIN_MB" ]; then
  logger -t "$tag" "RAM available ${avail_mb}MB below 15% — inspect desktop containers (docker stats --no-stream)"
fi

# CPU: 5-minute load average vs core count
cores=$(nproc)
load5=$(awk '{print $2}' /proc/loadavg)
load_pct=$(awk -v l="$load5" -v c="$cores" 'BEGIN {printf "%d", (l/c)*100}')
if [ "${load_pct:-0}" -gt "$LOAD_MAX_PCT" ]; then
  logger -t "$tag" "CPU sustained ${load_pct}% (${load5} load on ${cores} cores) — check sandbox firefox/ffmpeg (ps aux --sort=-%cpu | head)"
fi

exit 0
