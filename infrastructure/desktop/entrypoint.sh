#!/bin/bash
# entrypoint.sh — ORVYN virtual desktop:
#   Xvfb + openbox + tint2 top panel + tint2 bottom dock + feh wallpaper
#   + Thunar (file manager, opens /workspace centered) + jgmenu app menu
#
# The control plane captures frames via `docker exec ... import -window root jpeg:-`
# and injects input via `docker exec ... xdotool ...`.

set -e

# Start Xvfb on :99 at the configured resolution.
Xvfb :99 -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 1

# Session bus for thunar/GTK apps (best-effort).
if command -v dbus-launch &>/dev/null; then
  eval "$(dbus-launch --sh-syntax)" || true
fi

# Window manager.
openbox &
OPENBOX_PID=$!
sleep 1

# ORVYN wallpaper (deep-space / network motif, generated original art).
if command -v feh &>/dev/null; then
  feh --bg-scale /usr/share/backgrounds/orvyn/orvyn-desktop.png 2>/dev/null || \
    xsetroot -solid "#07122a" || true
else
  xsetroot -solid "#07122a" 2>/dev/null || true
fi

# Top panel (Activities, launcher, centered clock, indicators).
tint2 -c /home/orvyn/.config/tint2/top.conf &
TOP_PID=$!
sleep 0.4

# Bottom dock (terminal / files / chromium / editor / settings).
tint2 -c /home/orvyn/.config/tint2/dock.conf &
DOCK_PID=$!
sleep 0.6

# File manager — the default surface, showing the synced workspace.
thunar /workspace &
THUNAR_PID=$!
sleep 1.5

# Center + size the file manager window like the approved mockup.
wmctrl -r "orvyn - File Manager" -e "0,$((SCREEN_WIDTH*27/100)),$((SCREEN_HEIGHT*24/100)),$((SCREEN_WIDTH*46/100)),$((SCREEN_HEIGHT*52/100))" 2>/dev/null || \
wmctrl -r "File Manager" -e "0,$((SCREEN_WIDTH*27/100)),$((SCREEN_HEIGHT*24/100)),$((SCREEN_WIDTH*46/100)),$((SCREEN_HEIGHT*52/100))" 2>/dev/null || true

# Optional: a start URL opens Chromium alongside the file manager.
if [ -n "$START_URL" ]; then
  chromium --no-sandbox --disable-dev-shm-usage --start-maximized "$START_URL" &
fi

echo "=============================================="
echo " ORVYN Desktop sandbox ready on :99"
echo "   Resolution: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
echo "   WM: openbox + tint2 panel + dock"
echo "   Apps: Thunar, Chromium, lxterminal, geany"
echo "   Wallpaper: /usr/share/backgrounds/orvyn/orvyn-desktop.png"
echo "   Workspace: /workspace"
echo "=============================================="

# Keep alive — wait for Xvfb (the display server is the core).
wait $XVFB_PID
