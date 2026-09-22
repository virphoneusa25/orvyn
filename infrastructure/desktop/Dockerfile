# orvyn-desktop: sandbox desktop runtime
#
# A true visual sandbox desktop — not just a browser viewport:
#   Xvfb (virtual display) + openbox (lightweight WM) + Chromium + xterm
#   + xdotool (input injection) + ImageMagick (frame capture)
#
# The control plane drives everything from OUTSIDE the container via
# docker exec: frames come from `import -window root jpeg:-`, input goes
# through `xdotool`. No API server inside the sandbox.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      xauth \
      openbox \
      chromium \
      xterm \
      xdotool \
      imagemagick \
      x11-utils \
      wmctrl \
      procps \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the desktop session (GUI apps).
RUN useradd -m -s /bin/bash orvyn && \
    mkdir -p /home/orvyn/.config/chromium && \
    chown -R orvyn:orvyn /home/orvyn

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER orvyn
WORKDIR /home/orvyn

EXPOSE 5900

ENTRYPOINT ["/entrypoint.sh"]
