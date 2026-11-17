#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAIRING_FILE="$ROOT_DIR/data/pairing.json"
tailnet_host="${BRIDGE_HOST:-}"
port="${BRIDGE_PORT:-8787}"
public_url="${BRIDGE_PUBLIC_URL:-}"
tunnel_unit="${BRIDGE_TUNNEL_UNIT:-remote-browser-bridge-tunnel.service}"

if [[ ! -f "$PAIRING_FILE" ]]; then
  echo "Pairing file not found. Start the bridge before requesting remote info." >&2
  exit 1
fi

if [[ -z "$tailnet_host" ]]; then
  tailnet_host="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
fi
tailnet_host="${tailnet_host:-127.0.0.1}"

if [[ -z "$public_url" ]]; then
  public_url="$(journalctl -u "$tunnel_unit" --no-pager 2>/dev/null \
    | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | tail -n 1 || true)"
fi

printf 'Private console: http://%s:%s\n' "$tailnet_host" "$port"
printf 'Private WSS:     ws://%s:%s/ws\n' "$tailnet_host" "$port"

if [[ -n "$public_url" ]]; then
  printf 'Public console:  %s\n' "$public_url"
  printf 'Public WSS:      %s/ws\n' "${public_url/https:/wss:}"
else
  printf 'Public tunnel:   not available\n' >&2
fi

if [[ "${SHOW_PAIRING_TOKEN:-0}" == "1" ]]; then
  printf 'Pairing token:   %s\n' "$(jq -r '.token' "$PAIRING_FILE")"
else
  printf 'Pairing token:   hidden (set SHOW_PAIRING_TOKEN=1 to print)\n'
fi
