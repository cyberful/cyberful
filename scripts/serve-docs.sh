#!/usr/bin/env bash
# ── Local Engineer Documentation Server ──────────────────────────────
# Builds or serves the MkDocs site from its pinned isolated environment, binds
# to localhost by default, and replaces only the prior listener on its own port.
# Foreground serving uses exec so Ctrl+C cannot leave a detached docs process.
# → Makefile — exposes this script through the docs and docs-build targets.
# ─────────────────────────────────────────────────────────────────────

# DOCS_HOST and DOCS_PORT set the local bind; DOCS_ADDR overrides both.
# Pass `build` for a one-shot static build instead of the default live server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCS_HOST="${DOCS_HOST:-127.0.0.1}"
DOCS_PORT="${DOCS_PORT:-8010}"
DOCS_ADDR="${DOCS_ADDR:-$DOCS_HOST:$DOCS_PORT}"
REQ_FILE="$REPO_ROOT/docs-requirements.txt"
CONFIG="$REPO_ROOT/mkdocs.yml"
MODE="${1:-serve}"

if [[ ! "$DOCS_ADDR" =~ :([0-9]{1,5})$ ]]; then
  printf '\033[31m[docs] error:\033[0m DOCS_ADDR must end in a numeric TCP port.\n' >&2
  exit 1
fi
PORT="${BASH_REMATCH[1]}"
if (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  printf '\033[31m[docs] error:\033[0m documentation port must be between 1 and 65535.\n' >&2
  exit 1
fi
if [[ "$MODE" != "serve" && "$MODE" != "build" ]]; then
  printf '\033[31m[docs] error:\033[0m mode must be serve or build.\n' >&2
  exit 1
fi

# ── Pinned Dependencies Own The Documentation Compatibility ──────────
# Material's MkDocs 2 warning concerns a future dependency transition that this
# repository cannot receive because docs requirements are pinned. Its supported
# opt-out keeps routine builds quiet; dependency updates remain explicit review
# work rather than a warning emitted on every local invocation.
# ─────────────────────────────────────────────────────────────────────
export NO_MKDOCS_2_WARNING=true

# Diagnostics go to stderr (unbuffered): always visible and never lost to stdout
# block-buffering when `make docs` is piped/redirected and this script exec()s mkdocs.
log() { printf '\033[36m[docs]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[31m[docs] error:\033[0m %s\n' "$*" >&2; }

# ── Documentation Tooling Stays Outside Global Python ────────────────
# The site runs through uv with the repository requirements instead of mutating
# global Python packages. Existing uv installations are reused; otherwise one of
# the available user-scoped installers bootstraps it. The refreshed PATH applies
# only to this process before the pinned MkDocs environment starts.
# ─────────────────────────────────────────────────────────────────────
if ! command -v uv >/dev/null 2>&1; then
  log "uv not found — installing it (needed to run mkdocs-material in a pinned, isolated env)…"
  if command -v brew >/dev/null 2>&1; then
    brew install uv
  elif command -v pipx >/dev/null 2>&1; then
    pipx install uv
  elif command -v curl >/dev/null 2>&1; then
    curl -LsSf --connect-timeout 15 --max-time 120 --retry 2 https://astral.sh/uv/install.sh | sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=30 --tries=2 https://astral.sh/uv/install.sh | sh
  else
    err "cannot install uv automatically: need brew, pipx, curl, or wget on PATH."
    err "install uv manually — see https://docs.astral.sh/uv/ — then re-run 'make docs'."
    exit 1
  fi
  # The standalone installer drops uv in ~/.local/bin (or ~/.cargo/bin); make it visible now.
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  hash -r
fi
command -v uv >/dev/null 2>&1 || { err "uv still not available after install attempt."; exit 1; }
uv_version="$(uv --version)" || { err "uv is installed but cannot run."; exit 1; }
log "uv: $(command -v uv) ($uv_version)"

# Build mode validates the static site once and leaves no server process.
if [ "$MODE" = "build" ]; then
  shift || true
  log "building static site into ./site …"
  exec uv run --with-requirements "$REQ_FILE" \
    mkdocs build --config-file "$CONFIG" "$@"
fi

# ── Repeated Serving Reclaims The Configured Port ────────────────────
# `make docs` is intentionally restartable: an existing listener on the selected
# docs port is stopped before the next foreground server starts. The script waits
# for graceful release first and escalates only if the port remains occupied.
# Without lsof it cannot prove ownership, so it leaves listeners untouched.
# ─────────────────────────────────────────────────────────────────────
if command -v lsof >/dev/null 2>&1; then
  existing="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    owned=()
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$command" != *"mkdocs serve"* || "$command" != *"--config-file $CONFIG"* ]]; then
        err "port $PORT is owned by pid $pid, not this repository's MkDocs server."
        exit 1
      fi
      owned+=("$pid")
    done <<< "$existing"
    log "restarting this repository's existing MkDocs server on port $PORT (pid ${owned[*]})…"
    kill "${owned[@]}"
    # wait up to ~4s for the port to be released
    for _ in $(seq 1 20); do
      lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 0.2
    done
    still="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$still" ]; then
      force=()
      while IFS= read -r pid; do
        for owned_pid in "${owned[@]}"; do
          if [ "$pid" = "$owned_pid" ]; then force+=("$pid"); fi
        done
      done <<< "$still"
      if [ "${#force[@]}" -gt 0 ]; then
        log "the previous MkDocs process did not stop gracefully — forcing pid ${force[*]}…"
        kill -9 "${force[@]}"
        sleep 0.3
      fi
      if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        err "port $PORT remained occupied after the owned MkDocs process stopped."
        exit 1
      fi
    fi
  fi
else
  log "lsof not found — skipping the 'stop existing server' check."
fi

# Foreground exec makes MkDocs inherit Ctrl+C and own the configured listener.
log "serving at http://$DOCS_ADDR  —  press Ctrl+C to stop"
shift || true
exec uv run --with-requirements "$REQ_FILE" \
  mkdocs serve --config-file "$CONFIG" --dev-addr "$DOCS_ADDR" "$@"
