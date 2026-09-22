#!/bin/bash
# entrypoint.sh — starts the virtual display, window manager, and Chromium.
#
# The control plane captures frames via `docker exec ... import -window root jpeg:-`
# and injects input via `docker exec ... xdotool ...`. This script just keeps
# the desktop alive.

set -e

# Start Xvfb on :99 at the configured resolution.
Xvfb :99 -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 1

# Start openbox (lightweight window manager) on the virtual display.
openbox &
OPENBOX_PID=$!
sleep 1

# Set a desktop background color (dark navy, ORVYN-style).
xsetroot -solid "#0a0e1a" 2>/dev/null || true

# Open Chromium if a URL was provided, otherwise open a blank page.
if [ -n "$START_URL" ]; then
  chromium --no-sandbox --disable-dev-shm-usage --start-maximized "$START_URL" &
else
  chromium --no-sandbox --disable-dev-shm-usage --start-maximized about:blank &
fi

# Open a terminal (xterm) in the corner for desktop feel.
xterm -geometry "80x24+40+40" -title "Terminal" -bg "#0a0e1a" -fg "#e0e6f0" &
sleep 0.5

# Move Chromium window to fill most of the screen, terminal on top.
wmctrl -r "Chromium" -b add,maximized_vert,maximized_horz 2>/dev/null || true

echo "ORVYN Desktop sandbox ready on :99 (${SCREEN_WIDTH}x${SCREEN_HEIGHT})"
echo "  Chromium + xterm running under openbox"
echo "  Frames: docker exec <container> import -window root jpeg:-"
echo "  Input:  docker exec <container> xdotool <command>"

# Keep alive — wait for any child process to die.
wait $XVFB_PID
