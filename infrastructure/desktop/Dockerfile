# orvyn-desktop: sandbox desktop runtime
#
# A true visual sandbox desktop — not just a browser viewport:
#   Xvfb + openbox + tint2 (left rail, bottom dock, clock) + Thunar
#   + Firefox + lxterminal + VS Code (geany fallback)
#   + feh (ORVYN wallpaper) + xdotool (input) + ffmpeg (live picture)
#   + ImageMagick (single screenshots)
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
      firefox-esr \
      thunar \
      lxterminal \
      geany \
      lxappearance \
      jgmenu \
      gnome-themes-extra \
      xterm \
      xdotool \
      imagemagick \
      ffmpeg \
      x11-utils \
      wmctrl \
      procps \
      dbus-x11 \
      ca-certificates \
      wget \
      fonts-liberation \
      fonts-dejavu-core \
      papirus-icon-theme \
    && rm -rf /var/lib/apt/lists/*

# ORVYN brand assets: wallpaper, mark, dock glyphs, landing page.
COPY assets/ /usr/share/backgrounds/orvyn/
RUN mkdir -p /usr/share/orvyn/icons /usr/share/orvyn/indicators && \
    cp /usr/share/backgrounds/orvyn/orvyn-brand.png /usr/share/orvyn/orvyn-brand.png && \
    cp /usr/share/backgrounds/orvyn/orvyn-mark.png /usr/share/orvyn/ && \
    cp /usr/share/backgrounds/orvyn/orvyn-lockup.png /usr/share/orvyn/ && \
    cp /usr/share/backgrounds/orvyn/icons/* /usr/share/orvyn/icons/ && \
    cp /usr/share/backgrounds/orvyn/indicators/* /usr/share/orvyn/indicators/
COPY home.html /usr/share/orvyn/home.html
COPY openbox/themerc /usr/share/orvyn/openbox-themerc
COPY orvyn-input orvyn-launch /usr/local/bin/
RUN chmod 755 /usr/local/bin/orvyn-input /usr/local/bin/orvyn-launch

# Dock/panel launchers.
COPY apps/*.desktop /usr/share/applications/

# Firefox opens the ORVYN landing page for a new window.
RUN mkdir -p /etc/firefox/policies /etc/firefox-esr/policies
COPY firefox/policies.json /etc/firefox/policies/policies.json
COPY firefox/policies.json /etc/firefox-esr/policies/policies.json

# VS Code is the dock editor. Geany remains the fallback if this download fails.
RUN wget -qO /tmp/code.deb "https://update.code.visualstudio.com/latest/linux-deb-x64/stable" \
    && apt-get update \
    && apt-get install -y /tmp/code.deb \
    && rm -f /tmp/code.deb \
    && rm -rf /var/lib/apt/lists/* \
    || true

# Non-root user for the desktop session (GUI apps).
RUN useradd -m -s /bin/bash orvyn && \
    mkdir -p /home/orvyn/.config/tint2 /home/orvyn/.config/gtk-3.0 /home/orvyn/.config/Thunar /workspace /opt/orvyn/demo && \
    chown -R orvyn:orvyn /home/orvyn /workspace
COPY tint2-left.conf /home/orvyn/.config/tint2/left.conf
COPY tint2-dock.conf /home/orvyn/.config/tint2/dock.conf
COPY tint2-clock.conf /home/orvyn/.config/tint2/clock.conf
COPY config/gtk-3.0/ /home/orvyn/.config/gtk-3.0/
COPY config/Thunar/thunarrc /home/orvyn/.config/Thunar/thunarrc
COPY demo/ /opt/orvyn/demo/
RUN chown -R orvyn:orvyn /home/orvyn/.config /opt/orvyn/demo

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER orvyn
WORKDIR /home/orvyn

ENTRYPOINT ["/entrypoint.sh"]
