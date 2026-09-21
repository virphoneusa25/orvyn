#!/bin/bash
# infrastructure/ovh/bootstrap-control-plane.sh
#
# One-shot bootstrap for the ORVYN control plane on a fresh OVH server.
# Idempotent — safe to re-run. Installs Docker, configures the firewall,
# sets up SSH hardening, and starts the control-plane services.
#
# Usage: ssh ubuntu@server 'bash -s' < infrastructure/ovh/bootstrap-control-plane.sh
set -euo pipefail

echo "=== ORVYN Control Plane Bootstrap ==="

# ── SSH hardening ──────────────────────────────────────────────────────────
# Key-only auth, no root login, no password auth
SSH_CONFIG=/etc/ssh/sshd_config.d/99-orvyn-hardening.conf
if [ ! -f "$SSH_CONFIG" ]; then
  echo "→ SSH: key-only, no root, no passwords"
  mkdir -p /etc/ssh/sshd_config.d
  cat > "$SSH_CONFIG" << 'EOF'
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
MaxAuthTries 3
EOF
  # Validate before reloading — a broken sshd_config locks you out
  if sshd -t 2>/dev/null; then
    systemctl reload sshd
    echo "  ✓ SSH hardened (key-only, no root)"
  else
    echo "  ⚠ sshd config test failed — NOT reloading (would lock you out)"
    rm -f "$SSH_CONFIG"
  fi
else
  echo "→ SSH: already hardened"
fi

# ── Host firewall (UFW) ────────────────────────────────────────────────────
if ! command -v ufw >/dev/null 2>&1; then
  echo "→ Installing UFW..."
  apt-get update -qq && apt-get install -y -qq ufw
fi
echo "→ Firewall: SSH (22) + HTTPS (443) only"
ufw --force reset >/dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 443/tcp comment 'HTTPS/WSS'
# Port 80 only for ACME challenges (Caddy redirects to HTTPS)
ufw allow 80/tcp comment 'ACME + HTTP redirect'
ufw --force enable
echo "  ✓ Firewall active: 22, 80, 443"

# ── Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "→ Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker ubuntu
  echo "  ✓ Docker installed (ubuntu added to docker group)"
else
  echo "→ Docker: already installed ($(docker --version))"
fi

# ── Directory structure ────────────────────────────────────────────────────
echo "→ Directory structure"
mkdir -p ~/orvyn

echo ""
echo "=== Bootstrap complete ==="
echo "Next: copy the repo, set .env, then:"
echo "  docker compose -f docker-compose.yml \\"
echo "    -f infrastructure/ovh/compose.prod.yml \\"
echo "    -f infrastructure/ovh/compose.control-plane.yml up -d"
