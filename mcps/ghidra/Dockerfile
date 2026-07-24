# ── Headless Ghidra Runtime Image ─────────────────────────────────
# Builds the official Ghidra distribution from a checksum-pinned release and
# installs its bundled PyGhidra package without contacting Python package indexes.
# → mcps/ghidra/ghidra_mcp.py — owns the persistent MCP service.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

# The official archive contains a Linux x86_64 decompiler but no Linux ARM64
# decompiler. Apple Silicon therefore runs this image through Docker emulation.
ARG GHIDRA_PLATFORM=linux/amd64

FROM --platform=${GHIDRA_PLATFORM} eclipse-temurin:21-jdk-jammy AS ghidra-install

ARG GHIDRA_VERSION=12.1.2
ARG GHIDRA_RELEASE_DATE=20260605
ARG GHIDRA_SHA256=b62e81a0390618466c019c60d8c2f796ced2509c4c1aea4a37644a77272cf99d

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates curl unzip python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    archive="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_RELEASE_DATE}.zip"; \
    curl --fail --location --retry 3 \
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${archive}" \
      --output "/tmp/${archive}"; \
    printf '%s  %s\n' "${GHIDRA_SHA256}" "/tmp/${archive}" | sha256sum --check --strict; \
    unzip -q "/tmp/${archive}" -d /opt; \
    mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra; \
    rm "/tmp/${archive}"

RUN python3 -m pip install \
      --no-cache-dir \
      --no-index \
      --find-links /opt/ghidra/Ghidra/Features/PyGhidra/pypkg/dist \
      pyghidra

FROM --platform=${GHIDRA_PLATFORM} eclipse-temurin:21-jdk-jammy

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cyberful \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin cyberful

COPY --from=ghidra-install /opt/ghidra /opt/ghidra
COPY --from=ghidra-install /usr/local/lib/python3.10/dist-packages /usr/local/lib/python3.10/dist-packages
COPY ghidra_engine.py ghidra_mcp.py healthcheck.py /opt/cyberful-ghidra/

ENV GHIDRA_INSTALL_DIR=/opt/ghidra \
    CYBER_GHIDRA_HOST=127.0.0.1 \
    CYBER_GHIDRA_PORT=47100 \
    CYBER_GHIDRA_STORE=/ghidra/store \
    CYBER_GHIDRA_WORKAREA=/workspace \
    HOME=/ghidra/store/home \
    PYTHONUNBUFFERED=1

USER cyberful
HEALTHCHECK --interval=2s --timeout=2s --start-period=60s --retries=30 \
  CMD ["python3", "/opt/cyberful-ghidra/healthcheck.py"]
ENTRYPOINT ["python3", "/opt/cyberful-ghidra/ghidra_mcp.py"]
