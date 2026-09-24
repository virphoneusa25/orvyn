#!/bin/bash
# ORVYN virtual desktop: Xvfb + openbox + left rail + bottom dock + clock.
# Firefox, terminal, files, and VS Code. The desktop starts clean: apps open
# only when ORION or the user opens them from the dock.
#
# Pictures: the control plane streams the screen with ffmpeg (x11grab) while
# someone is watching. Older control planes read /tmp/orvyn-frame.jpg, which
# the loop below refreshes only while /tmp/orvyn-frame.want is being touched.

set -e

Xvfb :99 -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp &
XVFB_PID=$!
sleep 0.6

if command -v dbus-launch &>/dev/null; then
  eval "$(dbus-launch --sh-syntax)" || true
fi

export GTK_THEME=Adwaita-dark

mkdir -p \
  "$HOME/.config/openbox" \
  "$HOME/.themes/orvyn/openbox-3" \
  "$HOME/Documents" "$HOME/Downloads" "$HOME/Pictures" "$HOME/Music" "$HOME/Videos" \
  "$HOME/.local/share/Trash/files" \
  /tmp

if [ -f /etc/xdg/openbox/rc.xml ]; then
  cp /etc/xdg/openbox/rc.xml "$HOME/.config/openbox/rc.xml"
  sed -i 's/<name>Clearlooks<\/name>/<name>orvyn<\/name>/' "$HOME/.config/openbox/rc.xml" || true
fi
cp /usr/share/orvyn/openbox-themerc "$HOME/.themes/orvyn/openbox-3/themerc" 2>/dev/null || true

openbox &
sleep 0.4

if [ -f /usr/share/backgrounds/orvyn/orvyn-session.png ]; then
  feh --bg-scale /usr/share/backgrounds/orvyn/orvyn-session.png 2>/dev/null || xsetroot -solid "#07122a" || true
else
  feh --bg-scale /usr/share/backgrounds/orvyn/orvyn-desktop.png 2>/dev/null || xsetroot -solid "#07122a" || true
fi

# No left tint2 panel. Without a compositor its window is a solid black box.
tint2 -c /home/orvyn/.config/tint2/dock.conf &
sleep 0.2
tint2 -c /home/orvyn/.config/tint2/clock.conf &
sleep 0.3

# Show a project tree when the mounted workspace is empty and writable.
if [ -d /opt/orvyn/demo ] && [ -d /workspace ] && [ -z "$(ls -A /workspace 2>/dev/null)" ] && [ -w /workspace ]; then
  cp -a /opt/orvyn/demo/. /workspace/ || true
fi

if [ -n "$START_URL" ]; then
  /usr/local/bin/orvyn-launch browser "$START_URL" &
fi

# Frame file for control planes that poll. Idle unless someone asked for a
# picture in the last 10 seconds and no live ffmpeg stream is running.
(
  while true; do
    if [ -n "$(find /tmp/orvyn-frame.want -newermt '-10 seconds' 2>/dev/null)" ] && ! pgrep -x ffmpeg >/dev/null 2>&1; then
      if nice -n 19 xwd -root -silent | nice -n 19 convert -quality 45 xwd:- /tmp/orvyn-frame.jpg.new 2>/dev/null; then
        mv -f /tmp/orvyn-frame.jpg.new /tmp/orvyn-frame.jpg
      fi
      sleep 0.25
    else
      sleep 0.5
    fi
  done
) &

echo "=============================================="
echo " ORVYN Desktop sandbox ready on :99"
echo "   Resolution: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
echo "   Apps: Firefox, terminal, files, code"
echo "   Pictures: ffmpeg x11grab stream (frame file fallback)"
echo "=============================================="

wait $XVFB_PID
