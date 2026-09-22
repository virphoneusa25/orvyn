#!/usr/bin/env bash
# Build the ORVYN sandbox desktop runtime image.
# Run on the OVH worker (or any docker host):  ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${ORVYN_DESKTOP_IMAGE:-orvyn-desktop:latest}"
docker build -t "$IMAGE" .
echo "Built $IMAGE"
echo "Smoke test:  docker run --rm -d --name orvyn-desktop-smoke -e SCREEN_WIDTH=1280 -e SCREEN_HEIGHT=720 $IMAGE"
echo "Frame check: docker exec orvyn-desktop-smoke import -window root jpeg:- > /tmp/frame.jpg"
