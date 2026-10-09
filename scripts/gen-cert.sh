#!/usr/bin/env bash
# Self-signed dev certificate so phones on the LAN get a secure context (WebGPU
# requires HTTPS off-localhost). Covers localhost plus this machine's LAN IPs;
# on WSL it also picks up the Windows host's IPv4 addresses.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .certs

ips=$(hostname -I 2>/dev/null || true)
if [ -x /mnt/c/Windows/System32/ipconfig.exe ]; then
  ips="$ips $(/mnt/c/Windows/System32/ipconfig.exe | tr -d '\r' | sed -n 's/.*IPv4[^:]*: *\([0-9.]*\).*/\1/p')"
fi

san="DNS:localhost,IP:127.0.0.1"
for ip in $ips; do san="$san,IP:$ip"; done

# 825 days is the longest validity iOS accepts for TLS certificates.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout .certs/dev.key -out .certs/dev.crt \
  -subj "/CN=local-ai-harness dev" \
  -addext "subjectAltName=$san" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null

echo "Wrote .certs/dev.crt for: $san"
