# orvyn-desktop: sandbox desktop runtime
#
# A true visual sandbox desktop — not just a browser viewport:
#   Xvfb (virtual display) + openbox (lightweight WM) + tint2 (top panel +
#   bottom dock) + Thunar (file manager) + Chromium + lxterminal + geany
#   + feh (ORVYN wallpaper) + xdotool (input) + ImageMagick (frame capture)
#
# The control plane drives everything from OUTSIDE the container via
# docker exec: frames come from `xwd -root -silent | convert … jpeg:-`
# (import -window root can wait forever for a click), input goes through
# `xdotool`. No API server inside the sandbox.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=720

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      xauth \
      openbox \
      tint2 \
      feh \
      chromium \
      thunar \
      lxterminal \
      geany \
      lxappearance \
      jgmenu \
      xterm \
      xdotool \
      imagemagick \
      x11-utils \
      wmctrl \
      procps \
      dbus-x11 \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      papirus-icon-theme \
    && rm -rf /var/lib/apt/lists/*

# ORVYN brand assets: wallpaper, mark, indicator glyphs, landing page.
COPY assets/ /usr/share/backgrounds/orvyn/
RUN mkdir -p /usr/share/orvyn && \
    cp /usr/share/backgrounds/orvyn/orvyn-mark.png /usr/share/orvyn/ && \
    cp /usr/share/backgrounds/orvyn/orvyn-lockup.png /usr/share/orvyn/ && \
    cp -r /usr/share/backgrounds/orvyn/indicators /usr/share/orvyn/indicators
COPY home.html /usr/share/orvyn/home.html

# Dock/panel launchers.
COPY apps/*.desktop /usr/share/applications/

# Chromium defaults: ORVYN landing page as home/new-tab.
RUN mkdir -p /etc/chromium/policies/managed
COPY chromium/orvyn.json /etc/chromium/policies/managed/orvyn.json

# Non-root user for the desktop session (GUI apps).
RUN useradd -m -s /bin/bash orvyn && \
    mkdir -p /home/orvyn/.config/tint2 /home/orvyn/.config/chromium /workspace && \
    chown -R orvyn:orvyn /home/orvyn /workspace
COPY tint2-top.conf /home/orvyn/.config/tint2/top.conf
COPY tint2-dock.conf /home/orvyn/.config/tint2/dock.conf
RUN chown -R orvyn:orvyn /home/orvyn/.config

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER orvyn
WORKDIR /home/orvyn

ENTRYPOINT ["/entrypoint.sh"]
