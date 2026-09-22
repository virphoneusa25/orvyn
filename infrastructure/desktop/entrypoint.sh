#!/bin/bash
# entrypoint.sh — starts the virtual desktop: Xvfb + openbox + tint2 panel + Chromium + xterm
#
// The control plane captures frames via `docker exec ... import -window root jpeg:-`
// and injects input via `docker exec ... xdotool ...`. This script keeps
// the desktop alive and looking like a real computer.

set -e

# Start Xvfb on :99 at the configured resolution.
Xvfb :99 -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 1

# Start openbox (lightweight window manager).
openbox &
OPENBOX_PID=$!
sleep 1

# ORVYN-branded dark navy wallpaper.
xsetroot -solid "#0a0e1a" 2>/dev/null || true

# Start tint2 panel (taskbar) at the bottom if available.
if command -v tint2 &>/dev/null; then
  tint2 &
  PANEL_PID=$!
  sleep 0.5
fi

# Open Chromium (fills most of the screen).
if [ -n "$START_URL" ]; then
  chromium --no-sandbox --disable-dev-shm-usage --start-maximized --window-size=$((SCREEN_WIDTH-20)),$((SCREEN_HEIGHT-80)) "$START_URL" &
else
  chromium --no-sandbox --disable-dev-shm-usage --start-maximized --window-size=$((SCREEN_WIDTH-20)),$((SCREEN_HEIGHT-80)) about:blank &
fi
CHROMIUM_PID=$!

# Open a terminal (xterm) overlapping in the corner for desktop realism.
sleep 1
xterm -geometry "90x28+30+30" -title "Terminal — /workspace" -bg "#0a0e1a" -fg "#e0e6f0" -fa "Monospace:size=10" &
XTERM_PID=$!
sleep 0.5

# Position Chromium to fill most of the screen (leave room for the panel).
wmctrl -r "Chromium" -e "0,0,0,$SCREEN_WIDTH,$((SCREEN_HEIGHT-40))" 2>/dev/null || true
# Bring terminal on top.
wmctrl -r "Terminal" -b add,above 2>/dev/null || true

echo "=============================================="
echo " ORVYN Desktop sandbox ready on :99"
echo "   Resolution: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
echo "   WM: openbox + $(command -v tint2 >/dev/null && echo 'tint2 panel' || echo 'no panel')"
echo "   Apps: Chromium + xterm"
echo "   Wallpaper: #0a0e1a (ORVYN dark navy)"
echo "=============================================="
echo "  Frames: docker exec <ctr> import -window root jpeg:-"
echo "  Input:  docker exec <ctr> xdotool <command>"
echo "  Panel:  tint2 taskbar at bottom"
echo "=============================================="

# Keep alive — wait for Xvfb (the display server is the core).
wait $XVFB_PID
