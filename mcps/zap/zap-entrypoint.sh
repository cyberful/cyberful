#!/usr/bin/env sh
# ── Hardened ZAP Runtime Entrypoint ──────────────────────────────────
# Starts the headless ZAP daemon with loopback-only API and MCP listeners,
# required per-run credentials, disabled update traffic, and bounded defaults.
# → mcps/zap/zap_bridge.mjs — reaches these listeners from the bridge container.
# ─────────────────────────────────────────────────────────────────────

set -eu
umask 077

: "${CYBER_ZAP_API_KEY:?CYBER_ZAP_API_KEY is required}"
: "${CYBER_ZAP_MCP_KEY:?CYBER_ZAP_MCP_KEY is required}"

generation="${CYBER_ZAP_SESSION_GENERATION:-1}"
case "${generation}" in
  ''|*[!0-9]*) echo "CYBER_ZAP_SESSION_GENERATION must be a decimal integer" >&2; exit 2 ;;
esac
[ "${generation}" -ge 1 ] || { echo "CYBER_ZAP_SESSION_GENERATION must be positive" >&2; exit 2; }

history_response_body_bytes="${CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES:-1073741824}"
case "${history_response_body_bytes}" in
  ''|*[!0-9]*) echo "CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES must be a decimal integer" >&2; exit 2 ;;
esac
[ "${history_response_body_bytes}" -ge 16777216 ] || {
  echo "CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES must be at least 16777216" >&2
  exit 2
}
[ "${history_response_body_bytes}" -le 2147483647 ] || {
  echo "CYBER_ZAP_MAX_HISTORY_RESPONSE_BYTES must not exceed 2147483647" >&2
  exit 2
}

session_directory="${CYBER_ZAP_SESSION_ROOT:-/var/lib/cyberful/zap/session}"
session_path="${session_directory}/engagement-${generation}"
mkdir -p "${session_directory}"
if [ -f "${session_path}.session" ]; then
  session_option="-session"
else
  session_option="-newsession"
fi

certificate_path="${CYBER_ZAP_ROOT_CA_PATH:-/var/lib/cyberful/zap/root-ca.pem}"
mkdir -p "$(dirname "${certificate_path}")"
if [ -s "${certificate_path}" ]; then
  certificate_option="-certload"
else
  certificate_option="-certfulldump"
fi

exec /zap/zap-x.sh \
  "${session_option}" "${session_path}" \
  "${certificate_option}" "${certificate_path}" \
  -daemon \
  -silent \
  -notel \
  -host 0.0.0.0 \
  -port 8080 \
  -config "api.disablekey=false" \
  -config "api.key=${CYBER_ZAP_API_KEY}" \
  -config "api.addrs.addr.name=.*" \
  -config "api.addrs.addr.regex=true" \
  -config "api.filexfer=true" \
  -config "mcp.enabled=true" \
  -config "mcp.port=8282" \
  -config "mcp.securityKeyEnabled=true" \
  -config "mcp.securityKey=${CYBER_ZAP_MCP_KEY}" \
  -config "mcp.recordInHistory=true" \
  -config "mcp.secureOnly=false" \
  -config "checkForUpdatesOnStart=false" \
  -config "database.response.bodysize=${history_response_body_bytes}" \
  "$@"
