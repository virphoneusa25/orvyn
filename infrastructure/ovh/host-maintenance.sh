#!/usr/bin/env bash
# infrastructure/ovh/host-maintenance.sh — weekly disk retention for the OVH host.
#
# The measured problem: Docker build cache alone reached 60GB on a 96GB disk
# (80% full). This keeps build cache trimmed and clears dead containers and
# orphaned sandbox Xvfb/frame processes left on the host. Customer data
# (/data, /projects, volumes) is never touched.
#
# Installed by scripts/deploy-ovh.sh next to the backup timers.

set -uo pipefail

log() { printf '[host-maintenance] %s\n' "$*"; }

# Build cache older than 7 days (the daily deploys rebuild what they need).
if command -v docker >/dev/null 2>&1; then
  docker builder prune -f --filter until=168h >/dev/null 2>&1 \
    && log "build cache pruned (older than 7 days)" \
    || log "build cache prune failed"
  # Exited containers (never running ones).
  docker container prune -f >/dev/null 2>&1 && log "dead containers removed" || true
  # Dangling images only: tagged images are never removed here.
  docker image prune -f >/dev/null 2>&1 || true
fi

# Orphaned Xvfb displays on the HOST (desktops live in containers; a host
# Xvfb is a leak from before containerization or a crashed experiment).
if pgrep -x Xvfb >/dev/null 2>&1; then
  for pid in $(pgrep -x Xvfb); do
    # Only kill Xvfb whose parent is not a docker container runtime.
    if ! ps -o pid= -p "$pid" >/dev/null 2>&1; then continue; fi
    cgroup=$(cat "/proc/$pid/cgroup" 2>/dev/null || true)
    case "$cgroup" in
      *docker*|*containerd*) : ;;  # belongs to a container — leave it
      *) kill "$pid" 2>/dev/null && log "killed host-level Xvfb pid $pid" ;;
    esac
  done
fi

# System journal: cap at 200MB.
if command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-size=200M >/dev/null 2>&1 && log "journal capped at 200MB" || true
fi

df -h / | tail -1 | while read -r fs size used avail pct _m; do
  log "disk now: ${pct} used (${avail} available)"
done
