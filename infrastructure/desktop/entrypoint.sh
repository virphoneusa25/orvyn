#!/bin/bash
# ORVYN virtual desktop: Xvfb + openbox + left rail + bottom dock + clock.
# Firefox, terminal, files, and VS Code. Frames are written to
# /tmp/orvyn-frame.jpg so Take Control does not wait on a fresh grab.

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

tint2 -c /home/orvyn/.config/tint2/left.conf &
sleep 0.2
tint2 -c /home/orvyn/.config/tint2/dock.conf &
sleep 0.2
tint2 -c /home/orvyn/.config/tint2/clock.conf &
sleep 0.3

# Show a project tree when the mounted workspace is empty and writable.
if [ -d /opt/orvyn/demo ] && [ -d /workspace ] && [ -z "$(ls -A /workspace 2>/dev/null)" ] && [ -w /workspace ]; then
  cp -a /opt/orvyn/demo/. /workspace/ || true
fi

thunar /workspace &
sleep 1.2

wmctrl -r "workspace" -e "0,$((SCREEN_WIDTH*14/100)),$((SCREEN_HEIGHT*8/100)),$((SCREEN_WIDTH*50/100)),$((SCREEN_HEIGHT*68/100))" 2>/dev/null || \
wmctrl -r "File Manager" -e "0,$((SCREEN_WIDTH*14/100)),$((SCREEN_HEIGHT*8/100)),$((SCREEN_WIDTH*50/100)),$((SCREEN_HEIGHT*68/100))" 2>/dev/null || true

if [ -n "$START_URL" ]; then
  /usr/local/bin/orvyn-launch browser "$START_URL" &
fi

# Keep a JPEG ready. The control plane cats this file instead of capturing
# inside the Take Control request.
(
  while true; do
    if xwd -root -silent | convert -quality 55 xwd:- /tmp/orvyn-frame.jpg.new 2>/dev/null; then
      mv -f /tmp/orvyn-frame.jpg.new /tmp/orvyn-frame.jpg
    fi
    sleep 0.04
  done
) &

echo "=============================================="
echo " ORVYN Desktop sandbox ready on :99"
echo "   Resolution: ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
echo "   Apps: Firefox, terminal, files, code"
echo "   Frame: /tmp/orvyn-frame.jpg"
echo "=============================================="

wait $XVFB_PID
