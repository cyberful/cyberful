#!/usr/bin/env sh
# ── Hardened ZAP Runtime Entrypoint ──────────────────────────────────
# Starts the headless ZAP daemon with loopback-only API and MCP listeners,
# required per-run credentials, disabled update traffic, and bounded defaults.
# → mcps/zap/zap_bridge.mjs — reaches these listeners from the bridge container.
# ─────────────────────────────────────────────────────────────────────

set -eu

: "${CYBER_ZAP_API_KEY:?CYBER_ZAP_API_KEY is required}"
: "${CYBER_ZAP_MCP_KEY:?CYBER_ZAP_MCP_KEY is required}"

exec /zap/zap-x.sh \
  -daemon \
  -silent \
  -notel \
  -host 0.0.0.0 \
  -port 8080 \
  -config "api.disablekey=false" \
  -config "api.key=${CYBER_ZAP_API_KEY}" \
  -config "api.addrs.addr.name=.*" \
  -config "api.addrs.addr.regex=true" \
  -config "api.filexfer=false" \
  -config "mcp.enabled=true" \
  -config "mcp.port=8282" \
  -config "mcp.securityKeyEnabled=true" \
  -config "mcp.securityKey=${CYBER_ZAP_MCP_KEY}" \
  -config "mcp.recordInHistory=false" \
  -config "mcp.secureOnly=false" \
  -config "checkForUpdatesOnStart=false" \
  "$@"
