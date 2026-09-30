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
GATEWAY_DIGEST=sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2
SUPERVISOR_DIGEST=sha256:d7b5264bb6bc56f4796e6fa3617b8e4a8d785be0b7293542efd8cc250b0fb67a
SANDBOX_RUNTIME_DIGEST=sha256:bf4797b6c511f2d8ba02955dbba4bf76c1f0dd6d83531420c5408d5f1fb9d72f
TLS=/etc/orvyn/openshell/tls
cd "$(dirname "$0")/../.."

# `ar` is required to unpack the pinned CLI .deb without installing it.
# Fresh Ubuntu hosts do not include it.
if ! command -v ar >/dev/null 2>&1; then
  sudo apt-get update -qq
  DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq binutils
fi

# 1. Kernel: OpenShell's filesystem baseline needs Landlock ABI v3 (Linux 6.2+).
kernel=$(uname -r | cut -d. -f1-2)
if [ "$(printf '%s\n6.2\n' "$kernel" | sort -V | head -1)" != "6.2" ]; then
  echo "Kernel $kernel is older than 6.2 — OpenShell sandboxes will not start. Stay on Docker." >&2
  exit 1
fi

# 2. Pinned images (never :latest).
docker pull "ghcr.io/nvidia/openshell/gateway@$GATEWAY_DIGEST"
docker pull "ghcr.io/nvidia/openshell/supervisor@$SUPERVISOR_DIGEST"
docker pull "ghcr.io/nvidia/openshell/sandbox@$SANDBOX_RUNTIME_DIGEST"
# Keep the human-readable tags for the CLI and diagnostics. Runtime compose
# and gateway configuration below use immutable digest references.
docker tag "ghcr.io/nvidia/openshell/gateway@$GATEWAY_DIGEST" "ghcr.io/nvidia/openshell/gateway:$VERSION"
docker tag "ghcr.io/nvidia/openshell/supervisor@$SUPERVISOR_DIGEST" "ghcr.io/nvidia/openshell/supervisor:$VERSION"
docker tag "ghcr.io/nvidia/openshell/sandbox@$SANDBOX_RUNTIME_DIGEST" "ghcr.io/nvidia/openshell/sandbox:$VERSION"
docker build -t "orvyn/sandbox:$VERSION-2" infrastructure/openshell/sandbox-image
cat <<EOF | sudo tee /var/lib/openshell-digests.txt >/dev/null
OPEN_SHELL_VERSION=$VERSION
gateway=ghcr.io/nvidia/openshell/gateway@$GATEWAY_DIGEST
supervisor=ghcr.io/nvidia/openshell/supervisor@$SUPERVISOR_DIGEST
sandbox=ghcr.io/nvidia/openshell/sandbox@$SANDBOX_RUNTIME_DIGEST
workload=$(docker image inspect --format '{{.Id}}' "orvyn/sandbox:$VERSION-2")
EOF

# 3. mTLS PKI. Server SANs: the worker's service name, the sandbox callback
#    name, and the bridge address the host-side CLI uses.
BRIDGE_IP=${OPENSHELL_BRIDGE_IP:-172.17.0.1}
if [ ! -f "$TLS/ca.crt" ]; then
  sudo mkdir -p "$TLS"
  # The upstream gateway image runs as uid/gid 1000.  A root-owned 0755
  # output directory makes generate-certs fail with EPERM on a fresh host.
  # Grant the container user temporary write access and lock the tree back
  # down as soon as the certificate generator exits.
  sudo chown 1000:1000 "$TLS"
  sudo chmod 0700 "$TLS"
  sudo docker run --rm -v "$TLS:/out" "ghcr.io/nvidia/openshell/gateway:$VERSION" \
    generate-certs --output-dir /out --server-san openshell-gateway --server-san host.openshell.internal --server-san "$BRIDGE_IP"
  sudo chown -R root:root "$TLS"
  sudo chmod 0700 "$TLS" "$TLS/server" "$TLS/client" "$TLS/jwt"
  sudo chmod 600 "$TLS"/ca.key "$TLS"/server/tls.key "$TLS"/client/tls.key "$TLS"/jwt/signing.pem
fi
# Existing installations may have been generated before ownership was locked
# down. Enforce it on every setup/upgrade, not only on first certificate issue.
sudo chown -R root:root "$TLS"
for dir in "$TLS" "$TLS/server" "$TLS/client" "$TLS/jwt"; do
  [ ! -e "$dir" ] || sudo chmod 0700 "$dir"
done
for secret in "$TLS/ca.key" "$TLS/server/tls.key" "$TLS/client/tls.key" "$TLS/jwt/signing.pem"; do
  [ ! -e "$secret" ] || sudo chmod 0600 "$secret"
done
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
echo "  3. Redeploy imports the gateway/provider profiles and runs acceptance automatically."
