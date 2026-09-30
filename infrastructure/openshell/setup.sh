#!/usr/bin/env bash
# infrastructure/openshell/setup.sh — one-time OpenShell setup on the worker host.
#
# Run from the ORVYN checkout on the server (as a user with docker + sudo):
#   bash infrastructure/openshell/setup.sh
#
# Idempotent. It does NOT enable OpenShell for anyone; that is a separate,
# explicit step (OPENSHELL_ENABLED=true + a canary org flag) after
# scripts/acceptance/openshell-sandbox.mjs passes on this host.
set -euo pipefail
VERSION=0.1.2
TLS=/etc/orvyn/openshell/tls
cd "$(dirname "$0")/../.."

# 1. Kernel: OpenShell's filesystem baseline needs Landlock ABI v3 (Linux 6.2+).
kernel=$(uname -r | cut -d. -f1-2)
if [ "$(printf '%s\n6.2\n' "$kernel" | sort -V | head -1)" != "6.2" ]; then
  echo "Kernel $kernel is older than 6.2 — OpenShell sandboxes will not start. Stay on Docker." >&2
  exit 1
fi

# 2. Pinned images (never :latest).
docker pull "ghcr.io/nvidia/openshell/gateway:$VERSION"
docker pull "ghcr.io/nvidia/openshell/supervisor:$VERSION"
docker pull "ghcr.io/nvidia/openshell/sandbox:$VERSION"
docker build -t "orvyn/sandbox:$VERSION-1" infrastructure/openshell/sandbox-image
for i in gateway supervisor sandbox; do
  docker image inspect --format "ghcr.io/nvidia/openshell/$i:$VERSION {{index .RepoDigests 0}}" "ghcr.io/nvidia/openshell/$i:$VERSION"
done | sudo tee /var/lib/openshell-digests.txt >/dev/null

# 3. mTLS PKI. Server SANs: the worker's service name, the sandbox callback
#    name, and the bridge address the host-side CLI uses.
BRIDGE_IP=${OPENSHELL_BRIDGE_IP:-172.17.0.1}
if [ ! -f "$TLS/ca.crt" ]; then
  sudo mkdir -p "$TLS"
  sudo docker run --rm -v "$TLS:/out" "ghcr.io/nvidia/openshell/gateway:$VERSION" \
    generate-certs --output-dir /out --server-san openshell-gateway --server-san host.openshell.internal --server-san "$BRIDGE_IP"
  sudo chmod 600 "$TLS"/ca.key "$TLS"/server/tls.key "$TLS"/client/tls.key "$TLS"/jwt/signing.pem
fi
sudo mkdir -p /var/lib/openshell

# 4. Pinned CLI (admin use on the host only), checksum-verified.
CLI_DIR=/usr/local/lib/orvyn-openshell
if [ ! -x "$CLI_DIR/openshell" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/os.deb" "https://github.com/NVIDIA/OpenShell/releases/download/v$VERSION/openshell_${VERSION}-1_amd64.deb"
  echo "1f5416ea08f32fdc621f20a2cc0324298e60aba8bbe996459d9e3b44195f23df  $tmp/os.deb" | sha256sum -c -
  (cd "$tmp" && ar x os.deb && tar xf data.tar.* ./usr/bin/openshell)
  sudo install -D -m 0755 "$tmp/usr/bin/openshell" "$CLI_DIR/openshell"
  rm -rf "$tmp"
fi
sudo mkdir -p /root/.config/openshell/gateways/orvyn/mtls
sudo cp "$TLS/ca.crt" /root/.config/openshell/gateways/orvyn/mtls/ca.crt
sudo cp "$TLS/client/tls.crt" /root/.config/openshell/gateways/orvyn/mtls/tls.crt
sudo cp "$TLS/client/tls.key" /root/.config/openshell/gateways/orvyn/mtls/tls.key

echo "Setup done. Next (see docs/openshell.md):"
echo "  1. .env: OPENSHELL_ENABLED=true  ORVYN_EXECUTION_PROVIDER=auto   (no organization is on the canary yet)"
echo "  2. Redeploy: the deploy script adds infrastructure/ovh/compose.openshell.yml when OPENSHELL_ENABLED=true."
echo "  3. sudo $CLI_DIR/openshell gateway add https://$BRIDGE_IP:8080 --local --name orvyn"
echo "     sudo $CLI_DIR/openshell provider profile import -f infrastructure/openshell/provider-profiles/orvyn-github.yaml --global"
echo "  4. Acceptance (must be 100%): docker compose ... exec worker node scripts/acceptance/openshell-sandbox.mjs"
