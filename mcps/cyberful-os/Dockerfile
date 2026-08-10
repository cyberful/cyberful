# syntax=docker/dockerfile:1.7

# ── Unified Multi-Architecture Engagement Runtime ────────────────
# Builds cyberful-os, native Ghidra, headless ZAP, and their protocol bridges
#   into the single image owned by one Cyberful engagement.
# → mcps/cyberful-os/runtime_supervisor.py — owns optional service processes.
# @docs/runtimes/cyberful-os.md
# ─────────────────────────────────────────────────────────────────

ARG ZAP_VERSION=2.17.0
ARG BUN_VERSION=1.3.14
ARG ZAP_BASE_IMAGE=ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2
ARG BUN_BASE_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
ARG KALI_BASE_IMAGE=kalilinux/kali-rolling@sha256:82c8e267c5b46031c6671f7dc8a30b240dabdc7d129e07ac9290ec06dac9b93c
FROM ${ZAP_BASE_IMAGE} AS zap-runtime

ARG ZAP_VERSION
USER root
RUN rm -f \
  /zap/plugin/onlineMenu-*.zap \
  /zap/plugin/quickstart-*.zap \
  /zap/plugin/ascanrules-*.zap \
  /zap/plugin/spiderAjax-*.zap \
  /zap/plugin/authhelper-*.zap \
  /zap/plugin/graphql-*.zap \
  /zap/plugin/mcp-*.zap \
  /zap/plugin/oast-*.zap \
  /zap/plugin/openapi-*.zap \
  /zap/plugin/pscanrules-*.zap \
  /zap/plugin/reports-*.zap \
  /zap/plugin/websocket-*.zap
ADD --checksum=sha256:9c1b64c2fceda629f7c0ab0c21b5901035494f78da51d584972eaf85e94e91cc \
  https://github.com/zaproxy/zap-extensions/releases/download/ascanrules-v83/ascanrules-release-83.zap \
  /zap/plugin/ascanrules-release-83.zap
ADD --checksum=sha256:9850bb21d7d1ecf8593740069d1eae75b02fb7eefa19af54244c277677031500 \
  https://github.com/zaproxy/zap-extensions/releases/download/spiderAjax-v23.32.0/spiderAjax-release-23.32.0.zap \
  /zap/plugin/spiderAjax-release-23.32.0.zap
ADD --checksum=sha256:8618464c4959dcb90b81e1770304a2a3a0dc4ba31c8a72e518fa95ff0ecf9c01 \
  https://github.com/zaproxy/zap-extensions/releases/download/authhelper-v0.40.0/authhelper-beta-0.40.0.zap \
  /zap/plugin/authhelper-beta-0.40.0.zap
ADD --checksum=sha256:22f1246a302ef42b7eec9af340cc732494025a5fd6a0322d717dfccb44c5b8b3 \
  https://github.com/zaproxy/zap-extensions/releases/download/graphql-v0.33.0/graphql-alpha-0.33.0.zap \
  /zap/plugin/graphql-alpha-0.33.0.zap
ADD --checksum=sha256:adc8692a30bf6f23e5b597b95726f1588f4bd7d34ab57280481a91cbe35aca88 \
  https://github.com/zaproxy/zap-extensions/releases/download/mcp-v0.2.0/mcp-alpha-0.2.0.zap \
  /zap/plugin/mcp-alpha-0.2.0.zap
ADD --checksum=sha256:f06ecea02e2c1df4a164e737dd632afba4430225b2fdc2feb6042bdb1e976b3d \
  https://github.com/zaproxy/zap-extensions/releases/download/oast-v0.24.0/oast-beta-0.24.0.zap \
  /zap/plugin/oast-beta-0.24.0.zap
ADD --checksum=sha256:fe87dd63cb310131c4e7d8c14b675c97f4b7707eda8ccc5fd6042628b6f19ccf \
  https://github.com/zaproxy/zap-extensions/releases/download/openapi-v57/openapi-beta-57.zap \
  /zap/plugin/openapi-beta-57.zap
ADD --checksum=sha256:97814c5f1319a31b5041f1bbd1edfc312b3a539c7cd56f7903e9996858361fcb \
  https://github.com/zaproxy/zap-extensions/releases/download/pscanrules-v75/pscanrules-release-75.zap \
  /zap/plugin/pscanrules-release-75.zap
ADD --checksum=sha256:2e8d42a48e23aefa8a6174b52aa0a8a6b90aca2da0a8bf94ac61f4aaa070bc2c \
  https://github.com/zaproxy/zap-extensions/releases/download/reports-v0.46.0/reports-release-0.46.0.zap \
  /zap/plugin/reports-release-0.46.0.zap
ADD --checksum=sha256:f2c3035976531130494b5b9dfc02ca0ebd7e0388f740f68b6d4e775098be9fc6 \
  https://github.com/zaproxy/zap-extensions/releases/download/websocket-v37/websocket-release-37.zap \
  /zap/plugin/websocket-release-37.zap
# ── Pinned Add-ons Must Survive The Runtime UID Boundary ────────────────
# Docker ADD creates the downloaded archives with mode 0600, owned by the
# upstream zap user. The unified supervisor deliberately runs ZAP as the host
# engagement UID instead, so owner-only archives silently disappear from ZAP's
# add-on catalog. Read-only public archives preserve image immutability while
# allowing every validated runtime identity to load the exact pinned catalog.
# ───────────────────────────────────────────────────────────────────────────
RUN test -s "/zap/zap-${ZAP_VERSION}.jar" \
  && chmod 0444 /zap/plugin/*.zap \
  && chown -R zap:zap /zap/plugin

FROM --platform=$BUILDPLATFORM ${BUN_BASE_IMAGE} AS zap-bridge-build
ARG BUN_VERSION
WORKDIR /src
COPY zap/package.json zap/bun.lock ./
RUN test "$(bun --version)" = "${BUN_VERSION}" \
  && bun install --frozen-lockfile
COPY zap/zap_bridge.mjs zap/zap_history.mjs zap/zap_history_replay.mjs zap/zap_http_request.mjs \
  zap/zap_oast.mjs zap/zap_policy.mjs zap/zap_report_path.mjs zap/zap_tool_catalog.mjs ./
RUN bun build --target=node --format=esm --outfile=/out/zap_bridge.mjs ./zap_bridge.mjs

FROM ${KALI_BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive
ENV TORRC=/etc/tor/torrc
ENV CYBERFUL_OS_PYTHON_VENV=/opt/cyberful-os-venv
ENV PATH="${CYBERFUL_OS_PYTHON_VENV}/bin:${PATH}"

ARG JEB_INSTALLER_URL=""
ARG JEB_SHA256=""
ARG GHIDRA_VERSION=12.1.2+ds-0kali1
ARG CYBERFUL_RUNTIME_FINGERPRINT=source-unbundled

LABEL org.cyberful.managed-runtime="true" \
      org.cyberful.runtime-fingerprint="${CYBERFUL_RUNTIME_FINGERPRINT}"

# ───────────────────────────────────────────────────────────────────────────
# 1. APT defaults
# ───────────────────────────────────────────────────────────────────────────
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-cyberful-os-retries

# Keep APT groups separate so adding a mobile tool later does not invalidate
# base, network, OSINT, and credential-tool layers.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    iproute2 \
    jq \
    less \
    net-tools \
    netcat-traditional \
    openssh-client \
    perl \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    ruby \
    ruby-bundler \
    screen \
    tini \
    socat \
    tmux \
    unzip \
    util-linux \
    vim \
    wget \
    xauth \
    xvfb \
    zsh

# ───────────────────────────────────────────────────────────────────────────
# 2. Network / web / exploitation tools
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    bettercap \
    bloodhound \
    certipy-ad \
    dirb \
    dnsutils \
    evil-winrm \
    feroxbuster \
    ffuf \
    file \
    gobuster \
    hashcat \
    hydra \
    john \
    johnny \
    masscan \
    metasploit-framework \
    nikto \
    nodejs \
    npm \
    nmap \
    python3-impacket \
    responder \
    snmp \
    sqlmap \
    tcpdump \
    traceroute \
    tshark \
    firefox-esr \
    wfuzz \
    whatweb \
    whois \
  && (setcap -r /usr/lib/nmap/nmap || true)

# ───────────────────────────────────────────────────────────────────────────
# 3. OSINT / cloud / credential support
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    cewl \
    cloud-enum \
    crunch \
    libimage-exiftool-perl \
    patator \
    proxychains4 \
    python3-bs4 \
    python3-lxml \
    python3-requests \
    recon-ng \
    s3scanner \
    theharvester \
    tor

# ───────────────────────────────────────────────────────────────────────────
# 4. Mobile reverse engineering / static analysis (APT)
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    androguard \
    apktool \
    "ghidra=${GHIDRA_VERSION}" \
    jadx \
    radare2

# Keep the tool defaults stable across Kali package layout changes. The dirb
# package commonly installs its lists under /usr/share/dirb/wordlists, while
# many tools and examples expect the Kali compatibility path below.
RUN test -s /usr/share/dirb/wordlists/common.txt \
  && mkdir -p /usr/share/wordlists \
  && rm -rf /usr/share/wordlists/dirb \
  && ln -s /usr/share/dirb/wordlists /usr/share/wordlists/dirb \
  && test -s /usr/share/wordlists/dirb/common.txt

# ───────────────────────────────────────────────────────────────────────────
# 5. JWT cracking support
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global --omit=dev jwt-cracker@4.1.1 \
  && command -v jwt-cracker \
  && command -v johnny \
  && npm cache clean --force

# ───────────────────────────────────────────────────────────────────────────
# 6. JavaScript supply-chain scanners
# ───────────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://aquasecurity.github.io/trivy-repo/deb/public.key \
    | gpg --dearmor -o /usr/share/keyrings/trivy.gpg \
  && printf '%s\n' \
    'deb [signed-by=/usr/share/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb generic main' \
    > /etc/apt/sources.list.d/trivy.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends trivy \
  && command -v trivy \
  && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global --omit=dev retire@5.4.3 \
  && command -v retire \
  && npm cache clean --force

# ───────────────────────────────────────────────────────────────────────────
# 7. Python OSINT / credential packages
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python3 -m venv "${CYBERFUL_OS_PYTHON_VENV}" \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install --upgrade pip setuptools wheel \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install \
    h8mail \
    holehe \
    maigret \
    socialscan \
    websocket-client==1.8.0

# ───────────────────────────────────────────────────────────────────────────
# 8. Mobile dynamic analysis / mobile app security Python tools
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install \
    drozer \
    frida-tools \
    mobsf \
    objection

# JEB is commercial software. To include it in a private build, provide an
# authenticated installer URL and optional SHA256 at build time.
RUN if [[ -n "${JEB_INSTALLER_URL}" ]]; then \
      mkdir -p /opt/jeb \
      && curl -fsSL "${JEB_INSTALLER_URL}" -o /tmp/jeb.zip \
      && if [[ -n "${JEB_SHA256}" ]]; then echo "${JEB_SHA256}  /tmp/jeb.zip" | sha256sum -c -; fi \
      && unzip -q /tmp/jeb.zip -d /opt/jeb \
      && rm -f /tmp/jeb.zip \
      && find /opt/jeb -maxdepth 2 -type f -iname "jeb*" -perm /111 -print -quit \
        | xargs -r -I{} ln -sf "{}" /usr/local/bin/jeb; \
    else \
      mkdir -p /opt/jeb; \
    fi

# ───────────────────────────────────────────────────────────────────────────
# 9. Sherlock – username OSINT across social networks
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    git clone --depth=1 https://github.com/sherlock-project/sherlock.git /opt/sherlock \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install /opt/sherlock \
  && rm -rf /opt/sherlock/.git

# ───────────────────────────────────────────────────────────────────────────
# 10. Dehashed-style credential search helpers
# ───────────────────────────────────────────────────────────────────────────
RUN mkdir -p /opt/cred-tools \
  && printf '%s\n' \
    'admin:admin' \
    'admin:password' \
    'admin:changeme' \
    'administrator:administrator' \
    'root:root' \
    'root:toor' \
    'test:test' \
    'user:user' \
    'guest:guest' \
    'demo:demo' \
    > /opt/cred-tools/common-creds.txt \
  && echo "Built-in credential wordlist seeded"

# ───────────────────────────────────────────────────────────────────────────
# 11. cyberful-os wordlists — credentials + content discovery
#
# Credentials feed hydra/john/hashcat; content lists feed the web fuzzers
# (feroxbuster/ffuf/gobuster/dirb/wfuzz). The content lists are frequency-ordered
# (raft + API lists from SecLists) so capped/time-boxed scans hit early, unlike
# the sparse alphabetic dirb/common.txt. See wordlists/content/SOURCES.md for
# provenance. Committed under mcps/cyberful-os/wordlists/, so runtime stays offline.
# ───────────────────────────────────────────────────────────────────────────
COPY --chmod=0644 cyberful-os/wordlists/*.txt /usr/share/wordlists/cyberful-os/credentials/
COPY --chmod=0644 cyberful-os/wordlists/content/*.txt /usr/share/wordlists/cyberful-os/content/
RUN test -s /usr/share/wordlists/cyberful-os/credentials/2025-top200.txt \
  && test -s /usr/share/wordlists/cyberful-os/credentials/darkweb2017-top1000.txt \
  && test -s /usr/share/wordlists/cyberful-os/credentials/xato-1000.txt \
  && test -s /usr/share/wordlists/cyberful-os/credentials/xato-10000.txt \
  && test -s /usr/share/wordlists/cyberful-os/content/raft-medium-directories.txt \
  && test -s /usr/share/wordlists/cyberful-os/content/raft-medium-files.txt \
  && test -s /usr/share/wordlists/cyberful-os/content/api-endpoints.txt \
  && test -s /usr/share/wordlists/cyberful-os/content/api-objects.txt

# ───────────────────────────────────────────────────────────────────────────
# 12. Tor configuration for darkweb / anonymised OSINT
# ───────────────────────────────────────────────────────────────────────────
RUN mkdir -p /etc/tor \
  && printf "SOCKSPort 9050\nSOCKSPolicy accept *\nLog notice stdout\n" > /etc/tor/torrc \
  && printf "#!/bin/sh\nexec tor -f /etc/tor/torrc \$@\n" > /usr/local/bin/tor-run \
  && chmod +x /usr/local/bin/tor-run

# ───────────────────────────────────────────────────────────────────────────
# 12b. TLS / web / recon scanners (testssl, sslscan, nuclei, httpx, subfinder)
#
# Added in a late, self-contained layer so the earlier tool groups stay cached.
# ProjectDiscovery tools (nuclei, httpx, subfinder) phone home by default
# (version/update checks + PDCP). cyberful-os forbids outbound telemetry, so we
# disable update checks at the env + per-tool config level and pre-seed nuclei
# templates once at build time; runtime stays offline. OAST/interactsh is an
# external server and is left OFF by default (callers opt in with engagement
# authorization). The MCP tool specs also bake -disable-update-check / -duc /
# -no-interactsh into their usage + examples as defense in depth.
# ───────────────────────────────────────────────────────────────────────────
ENV DISABLE_UPDATE_CHECK=true \
    PDCP_API_KEY=""
# Pinned, signed nuclei-templates release (github.com/projectdiscovery/nuclei-templates
# /releases). Bump to refresh the corpus; the build fails loud if the tag has no templates.
ARG NUCLEI_TEMPLATES_VERSION=10.4.5
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    sslscan \
    testssl.sh \
    nuclei \
    subfinder \
    httpx-toolkit \
  && mkdir -p /root/.config/nuclei /root/.config/httpx /root/.config/subfinder /root/.local \
  && printf 'disable-update-check: true\n' > /root/.config/nuclei/config.yaml \
  && printf 'disable-update-check: true\n' > /root/.config/httpx/config.yaml \
  && printf 'disable-update-check: true\n' > /root/.config/subfinder/config.yaml \
  # Kali ships ProjectDiscovery httpx as `httpx-toolkit` (the bare `httpx` name
  # is the unrelated Python lib). Pin a deterministic binary the MCP can call.
  && PD_HTTPX="$(command -v httpx-toolkit || command -v httpx)" \
  && test -n "${PD_HTTPX}" \
  && ln -sf "${PD_HTTPX}" /usr/local/bin/httpx-pd \
  # Install nuclei templates from the SIGNED release tarball directly. Do NOT use
  # `nuclei -update-templates`: the Kali-packaged nuclei has its self-updater stubbed,
  # so that command prints the banner and exits 0 WITHOUT downloading anything — it
  # silently shipped a templates-less image, and every scan then fataled with
  # "no templates provided for scan". The GitHub release archive carries the full
  # corpus with per-template `# digest:` signatures (verified against PD's key at
  # runtime) plus `.nuclei-ignore`; we extract it into nuclei's managed location and
  # mirror `.nuclei-ignore` + a templates-config stub into the config dir so runtime
  # invocations (which pass neither -t nor -ud) resolve it. Needs GitHub egress at
  # build; runtime stays offline (every invocation passes -disable-update-check). Fail
  # LOUD — assert at least one template landed (SHELL uses pipefail, no `|| true`).
  && curl -fsSL "https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/v${NUCLEI_TEMPLATES_VERSION}.zip" -o /tmp/nuclei-templates.zip \
  && unzip -q /tmp/nuclei-templates.zip -d /tmp/nt \
  && mv "/tmp/nt/nuclei-templates-${NUCLEI_TEMPLATES_VERSION}" /root/.local/nuclei-templates \
  && rm -rf /tmp/nuclei-templates.zip /tmp/nt \
  && cp /root/.local/nuclei-templates/.nuclei-ignore /root/.config/nuclei/.nuclei-ignore \
  && printf '{"nuclei-templates-directory":"/root/.local/nuclei-templates","nuclei-templates-latest-version":"%s"}\n' "${NUCLEI_TEMPLATES_VERSION}" > /root/.config/nuclei/.templates-config.json \
  && test -n "$(find /root/.local/nuclei-templates -name '*.yaml' -print -quit)" \
  && command -v testssl \
  && command -v sslscan \
  && command -v nuclei \
  && command -v subfinder \
  && test -x /usr/local/bin/httpx-pd

# ───────────────────────────────────────────────────────────────────────────
# 12c. Exploit search + GraphQL testing
#
# A late, self-contained layer (like 12b) so the earlier tool groups stay
# cached. exploitdb ships `searchsploit` with a bundled offline copy of the
# Exploit-DB under /usr/share/exploitdb, so runtime stays offline (a
# `searchsploit -u` refresh is opt-in). graphqlmap (swisskyrepo/GraphQLmap) is a
# GraphQL introspection/injection console; `pip install` builds it from the
# cloned setup.py — which declares no dependencies, and whose bin/graphqlmap
# falls back gracefully when the optional readline module is absent — installing
# the graphqlmap package plus the `graphqlmap` entry script into the venv, then
# symlinked onto PATH for the MCP to call.
# ───────────────────────────────────────────────────────────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends exploitdb \
  && command -v searchsploit \
  && test -s /usr/share/exploitdb/files_exploits.csv

RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    git clone --depth=1 https://github.com/swisskyrepo/GraphQLmap.git /opt/graphqlmap \
  && rm -rf /opt/graphqlmap/.git \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install /opt/graphqlmap \
  && ln -sf "${CYBERFUL_OS_PYTHON_VENV}/bin/graphqlmap" /usr/local/bin/graphqlmap \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/python" -c "import graphqlmap" \
  && command -v graphqlmap

# ───────────────────────────────────────────────────────────────────────────
# 12d. Specialist code, cloud, supply-chain, Kubernetes, and fuzzing tools
#
# Python analyzers use private venvs so their large, tightly pinned dependency
# graphs cannot destabilize the mobile/OSINT runtime. Release binaries are
# version-pinned and verified against upstream checksums; Jazzer publishes no
# checksum asset, so both supported archive digests are pinned here directly.
# Runtime update checks and usage metrics remain disabled. Vulnerability DB
# refreshes are explicit scan inputs, not implicit image-start side effects.
# ───────────────────────────────────────────────────────────────────────────
ARG TARGETARCH
ENV DO_NOT_TRACK=1 \
    SEMGREP_SEND_METRICS=off \
    SYFT_CHECK_FOR_APP_UPDATE=false \
    GRYPE_CHECK_FOR_APP_UPDATE=false

ARG SEMGREP_VERSION=1.170.0
ARG CLOUDSPLAINING_VERSION=0.9.1
ARG PROWLER_VERSION=5.33.2
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python3 -m venv /opt/semgrep-venv \
  && /opt/semgrep-venv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/semgrep-venv/bin/pip install "semgrep==${SEMGREP_VERSION}" \
  && /opt/semgrep-venv/bin/pip check \
  && ln -sf /opt/semgrep-venv/bin/semgrep /usr/local/bin/semgrep \
  && semgrep --version

RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python3 -m venv /opt/cloudsplaining-venv \
  && /opt/cloudsplaining-venv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/cloudsplaining-venv/bin/pip install "cloudsplaining==${CLOUDSPLAINING_VERSION}" \
  && /opt/cloudsplaining-venv/bin/pip check \
  && ln -sf /opt/cloudsplaining-venv/bin/cloudsplaining /usr/local/bin/cloudsplaining \
  && cloudsplaining --version

RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3-dev \
  && python3 -m venv /opt/prowler-venv \
  && /opt/prowler-venv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/prowler-venv/bin/pip install "prowler==${PROWLER_VERSION}" \
  && /opt/prowler-venv/bin/pip check \
  && /opt/prowler-venv/bin/python -c "from importlib.metadata import version; assert version('prowler') == '${PROWLER_VERSION}'"

ARG SYFT_VERSION=1.44.0
ARG GRYPE_VERSION=0.112.0
ARG GITLEAKS_VERSION=8.30.1
RUN set -eux; \
    case "${TARGETARCH}" in amd64|arm64) RELEASE_ARCH="${TARGETARCH}" ;; *) echo "unsupported cyberful-os architecture: ${TARGETARCH}" >&2; exit 1 ;; esac; \
    SYFT_ASSET="syft_${SYFT_VERSION}_linux_${RELEASE_ARCH}.tar.gz"; \
    GRYPE_ASSET="grype_${GRYPE_VERSION}_linux_${RELEASE_ARCH}.tar.gz"; \
    curl -fsSL "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/${SYFT_ASSET}" -o "/tmp/${SYFT_ASSET}"; \
    curl -fsSL "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_checksums.txt" -o /tmp/syft-checksums.txt; \
    grep "  ${SYFT_ASSET}$" /tmp/syft-checksums.txt > /tmp/syft-check; \
    (cd /tmp && sha256sum -c syft-check); \
    tar -xzf "/tmp/${SYFT_ASSET}" -C /usr/local/bin syft; \
    curl -fsSL "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/${GRYPE_ASSET}" -o "/tmp/${GRYPE_ASSET}"; \
    curl -fsSL "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_checksums.txt" -o /tmp/grype-checksums.txt; \
    grep "  ${GRYPE_ASSET}$" /tmp/grype-checksums.txt > /tmp/grype-check; \
    (cd /tmp && sha256sum -c grype-check); \
    tar -xzf "/tmp/${GRYPE_ASSET}" -C /usr/local/bin grype; \
    if [[ "${RELEASE_ARCH}" == "amd64" ]]; then GITLEAKS_ARCH=x64; else GITLEAKS_ARCH=arm64; fi; \
    GITLEAKS_ASSET="gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz"; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ASSET}" -o "/tmp/${GITLEAKS_ASSET}"; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" -o /tmp/gitleaks-checksums.txt; \
    grep "  ${GITLEAKS_ASSET}$" /tmp/gitleaks-checksums.txt > /tmp/gitleaks-check; \
    (cd /tmp && sha256sum -c gitleaks-check); \
    tar -xzf "/tmp/${GITLEAKS_ASSET}" -C /usr/local/bin gitleaks; \
    rm -f /tmp/syft* /tmp/grype* /tmp/gitleaks*; \
    syft version; \
    grype version; \
    gitleaks version

ARG KUBECTL_VERSION=1.36.0
ARG KUBE_BENCH_VERSION=0.15.6
RUN set -eux; \
    case "${TARGETARCH}" in amd64|arm64) RELEASE_ARCH="${TARGETARCH}" ;; *) echo "unsupported cyberful-os architecture: ${TARGETARCH}" >&2; exit 1 ;; esac; \
    curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${RELEASE_ARCH}/kubectl" -o /tmp/kubectl; \
    curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${RELEASE_ARCH}/kubectl.sha256" -o /tmp/kubectl.sha256; \
    echo "$(cat /tmp/kubectl.sha256)  /tmp/kubectl" | sha256sum -c -; \
    install -m 0755 /tmp/kubectl /usr/local/bin/kubectl; \
    KUBE_BENCH_ASSET="kube-bench_${KUBE_BENCH_VERSION}_linux_${RELEASE_ARCH}.tar.gz"; \
    curl -fsSL "https://github.com/aquasecurity/kube-bench/releases/download/v${KUBE_BENCH_VERSION}/${KUBE_BENCH_ASSET}" -o "/tmp/${KUBE_BENCH_ASSET}"; \
    curl -fsSL "https://github.com/aquasecurity/kube-bench/releases/download/v${KUBE_BENCH_VERSION}/kube-bench_${KUBE_BENCH_VERSION}_checksums.txt" -o /tmp/kube-bench-checksums.txt; \
    grep "  ${KUBE_BENCH_ASSET}$" /tmp/kube-bench-checksums.txt > /tmp/kube-bench-check; \
    (cd /tmp && sha256sum -c kube-bench-check); \
    mkdir -p /opt/kube-bench; \
    tar -xzf "/tmp/${KUBE_BENCH_ASSET}" -C /opt/kube-bench; \
    ln -sf /opt/kube-bench/kube-bench /usr/local/bin/kube-bench; \
    rm -f /tmp/kubectl /tmp/kubectl.sha256 /tmp/kube-bench*; \
    kubectl version --client=true; \
    kube-bench version; \
    test -s /opt/kube-bench/cfg/cis-1.24/config.yaml

# Foundry is installed from one immutable, checksummed release rather than
# through foundryup. Forge may acquire the exact Solidity compiler requested by
# an engagement; Bug Bounty mounts its SVM cache inside the engagement workarea.
ARG FOUNDRY_VERSION=1.7.1
ENV SVM_HOME=/root/.svm \
    FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RUN set -eux; \
    case "${TARGETARCH}" in amd64|arm64) FOUNDRY_ARCH="${TARGETARCH}" ;; *) echo "unsupported cyberful-os architecture: ${TARGETARCH}" >&2; exit 1 ;; esac; \
    FOUNDRY_ASSET="foundry_v${FOUNDRY_VERSION}_linux_${FOUNDRY_ARCH}.tar.gz"; \
    FOUNDRY_CHECKSUM="foundry_v${FOUNDRY_VERSION}_linux_${FOUNDRY_ARCH}.sha256"; \
    curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/${FOUNDRY_ASSET}" -o "/tmp/${FOUNDRY_ASSET}"; \
    curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/${FOUNDRY_CHECKSUM}" -o "/tmp/${FOUNDRY_CHECKSUM}"; \
    (cd /tmp && sha256sum -c "${FOUNDRY_CHECKSUM}"); \
    tar -xzf "/tmp/${FOUNDRY_ASSET}" -C /usr/local/bin forge cast anvil chisel; \
    rm -f "/tmp/${FOUNDRY_ASSET}" "/tmp/${FOUNDRY_CHECKSUM}"; \
    forge --version | grep -F "${FOUNDRY_VERSION}"; \
    cast --version | grep -F "${FOUNDRY_VERSION}"; \
    anvil --version | grep -F "${FOUNDRY_VERSION}"; \
    chisel --version | grep -F "${FOUNDRY_VERSION}"

ARG JAZZER_RELEASE=0.30.0
ARG JAZZER_LINUX_AMD64_SHA256=6eeaf0026d75599b07527d93b576593ce847cfca8b337a579971a5a9cdf792d0
ARG JAZZER_LINUX_ARM64_SHA256=16636a4d3e98f1d3a7fcf59d4ab37f5be1d1ad6df9d94d5c3ca8de644838e369
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    afl++ \
    clang \
    default-jre-headless \
    libclang-rt-dev \
    llvm \
  && case "${TARGETARCH}" in \
      amd64) JAZZER_ARCH=x86-64; JAZZER_SHA256="${JAZZER_LINUX_AMD64_SHA256}" ;; \
      arm64) JAZZER_ARCH=arm64; JAZZER_SHA256="${JAZZER_LINUX_ARM64_SHA256}" ;; \
      *) echo "unsupported cyberful-os architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/CodeIntelligenceTesting/jazzer/releases/download/v${JAZZER_RELEASE}/jazzer-linux-${JAZZER_ARCH}.tar.gz" -o /tmp/jazzer.tar.gz \
  && echo "${JAZZER_SHA256}  /tmp/jazzer.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/jazzer \
  && tar -xzf /tmp/jazzer.tar.gz -C /opt/jazzer \
  && ln -sf /opt/jazzer/jazzer /usr/local/bin/jazzer \
  && rm -f /tmp/jazzer.tar.gz \
  && command -v afl-fuzz \
  && command -v afl-clang-fast \
  && command -v clang \
  && command -v clang++ \
  && test -s /opt/jazzer/jazzer_standalone.jar \
  && jazzer --version \
  && clang --version

# ───────────────────────────────────────────────────────────────────────────
# 12a. Native, firmware, debugger, and protocol laboratory
# ───────────────────────────────────────────────────────────────────────────
# User-mode QEMU is invoked explicitly by the native lab. The image deliberately
# omits qemu-user-binfmt and full-system emulators so building CyberOS never
# mutates host-global binfmt registrations or promises unsupported hardware.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    bear \
    binutils-multiarch \
    binwalk \
    checksec \
    clang-tidy \
    clang-tools \
    cmake \
    cpio \
    cppcheck \
    device-tree-compiler \
    dosfstools \
    e2fsprogs \
    elfutils \
    gdb-multiarch \
    gdbserver \
    golang-go \
    ltrace \
    meson \
    ninja-build \
    patchelf \
    pkg-config \
    python3-backports.zstd \
    python3-pwntools \
    python3-ropgadget \
    python3-ubireader \
    qemu-user \
    ropper \
    squashfs-tools \
    strace \
    u-boot-tools \
    unblob \
    valgrind \
    7zip \
    xclip \
    xxd \
  && test -x /usr/bin/7z \
  && ln -sf /usr/bin/7z /usr/local/bin/7zz \
  && apt-get purge -y qemu-user-binfmt \
  && rm -f /usr/share/binfmts/qemu-* \
  && if dpkg-query -W -f='${db:Status-Status}\n' qemu-user-binfmt 2>/dev/null | grep -qx installed; then exit 1; fi \
  && test ! -e /usr/share/binfmts/qemu-aarch64 \
  && command -v gdb-multiarch \
  && command -v qemu-aarch64 \
  && command -v unblob \
  && command -v clang-tidy \
  && command -v afl-showmap \
  && command -v afl-tmin \
  && command -v afl-whatsup \
  && command -v 7zz \
  && command -v xclip \
  && command -v xxd

ARG BOOFUZZ_VERSION=0.4.2
ARG ROPGADGET_VERSION=7.7
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install \
      "boofuzz==${BOOFUZZ_VERSION}" \
      "ROPGadget==${ROPGADGET_VERSION}" \
  && ln -sf "${CYBERFUL_OS_PYTHON_VENV}/bin/ROPgadget" /usr/local/bin/ROPgadget \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/python" -c 'from importlib.metadata import version; print(version("boofuzz"))' \
  && ROPgadget --version

ARG ZGRAB2_REVISION=e8fbc9eff2304403c3c574af3d6b65abfc2032b3
ARG ZGRAB2_SHA256=dc38bbe35e645d749fbcf31e27a38a44d4aaf30ab2d809ce97bb5a4741cf00f2
RUN curl -fsSL "https://github.com/zmap/zgrab2/archive/${ZGRAB2_REVISION}.tar.gz" -o /tmp/zgrab2.tar.gz \
  && echo "${ZGRAB2_SHA256}  /tmp/zgrab2.tar.gz" | sha256sum -c - \
  && mkdir -p /tmp/zgrab2 \
  && tar -xzf /tmp/zgrab2.tar.gz --strip-components=1 -C /tmp/zgrab2 \
  && cd /tmp/zgrab2 \
  && go build -trimpath -ldflags="-buildid=" -o /usr/local/bin/zgrab2 ./cmd/zgrab2 \
  && zgrab2 --help >/dev/null \
  && rm -rf /tmp/zgrab2 /tmp/zgrab2.tar.gz

# ───────────────────────────────────────────────────────────────────────────
# 13. Final touches
# ───────────────────────────────────────────────────────────────────────────
RUN mkdir -p /etc/kali-motd \
  && touch /etc/kali-motd/disable-all \
  && printf '%s\n' \
    '#!/bin/sh' \
    '' \
    'if ! [ -t 0 ]; then' \
    '  exit 0' \
    'fi' \
    '' \
    "cat <<'EOF'" \
    '┏━ cyberful-os from Cyberful' \
    '┃' \
    '┃ Authorized access and use only.' \
    '┃ This environment is intended exclusively for lawful cybersecurity,' \
    '┃ research, analysis, and defensive operations.' \
    '┃' \
    '┃ Any abuse, unauthorized access, or unlawful use is prohibited.' \
    '┃ Users are responsible for their own actions.' \
    '┃' \
    '┗━' \
    'EOF' \
    > /usr/local/bin/cyberful-os-motd \
  && chmod +x /usr/local/bin/cyberful-os-motd \
  && printf 'export CYBERFUL_OS_READY=1\nexport PATH="%s/bin:$PATH"\n/usr/local/bin/cyberful-os-motd\n' "${CYBERFUL_OS_PYTHON_VENV}" > /etc/profile.d/cyberful-os.sh \
  && if [[ -x /usr/share/ghidra/ghidraRun ]]; then ln -sf /usr/share/ghidra/ghidraRun /usr/local/bin/ghidraRun; fi \
  && if [[ -x /usr/share/ghidra/support/analyzeHeadless ]]; then ln -sf /usr/share/ghidra/support/analyzeHeadless /usr/local/bin/analyzeHeadless; fi \
  && for tool in sherlock holehe h8mail maigret socialscan frida frida-ps frida-trace objection drozer drozer-complete drozer-repository mobsf; do \
      if [[ -x "${CYBERFUL_OS_PYTHON_VENV}/bin/${tool}" ]]; then \
        ln -sf "${CYBERFUL_OS_PYTHON_VENV}/bin/${tool}" "/usr/local/bin/${tool}"; \
      fi; \
    done \
  && echo 'export PS1="cyberful-os \\w \\$ "' >> /etc/bash.bashrc \
  && rm -rf /var/cache/apt/archives/*.deb /root/.cache/pip

# The MCP catalog is a build contract, not documentation. Copy the exact
# registry implementation shipped beside this image and fail the build if any
# required command or Python module is absent. The smoke probes also catch
# installations that leave a binary on PATH but cannot actually initialize.
COPY cyberful-os/cyberful_os_mcp.py /opt/cyberful-os/cyberful_os_mcp.py
COPY cyberful-os/mcp_framing.py /opt/cyberful-os/mcp_framing.py
COPY cyberful-os/native_security.py /opt/cyberful-os/native_security.py
COPY cyberful-os/prowler_offline.py /usr/local/bin/prowler
RUN chmod 0755 /usr/local/bin/prowler \
  && python3 /opt/cyberful-os/cyberful_os_mcp.py --verify-capabilities \
  && rg --version \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/python" -c 'import websocket; print(websocket.__version__)' \
  && nuclei -version \
  && semgrep --version \
  && syft version \
  && grype version \
  && gitleaks version \
  && prowler -v \
  && kubectl version --client=true \
  && kube-bench version \
  && forge --version \
  && cast --version \
  && anvil --version \
  && chisel --version \
  && jazzer --version \
  && (afl-fuzz -h > /tmp/afl-help 2>&1 || [[ "$?" -eq 1 ]]) \
  && grep -q "afl-fuzz \[ options \]" /tmp/afl-help \
  && rm -f /tmp/afl-help \
  && clang --version \
  && checksec --version \
  && gdb-multiarch --version \
  && unblob --version \
  && zgrab2 --help >/dev/null \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/python" -c 'import boofuzz' \
  && /usr/bin/python3 -c 'import pwn' \
  && msfconsole -q -x 'version; exit'

COPY --from=zap-runtime /zap /zap
COPY zap/zap-entrypoint.sh /usr/local/bin/cyberful-zap
COPY --from=zap-bridge-build /out/zap_bridge.mjs /opt/cyberful/zap/zap_bridge.mjs
COPY ghidra/ghidra_engine.py ghidra/ghidra_mcp.py ghidra/ghidra_bridge.py ghidra/healthcheck.py /opt/cyberful/ghidra/
COPY cyberful-os/runtime_supervisor.py /opt/cyberful/runtime-supervisor
COPY cyberful-os/runtime_attestation.py /opt/cyberful/runtime-attestation
COPY cyberful-os/tls_canary.py /opt/cyberful/tls-canary

# ───────────────────────────────────────────────────────────────────────────
# 14. Unified runtime contract
#
# Kali supplies architecture-native Ghidra decompilers and bundled PyGhidra
# wheels. Installation stays offline at this point, and the final attestation
# proves the image selected the decompiler matching TARGETARCH rather than an
# emulated foreign binary. ZAP remains optional at runtime but complete at build.
# ───────────────────────────────────────────────────────────────────────────
ARG ZAP_VERSION
ENV CYBERFUL_ZAP_VERSION=${ZAP_VERSION} \
    GHIDRA_INSTALL_DIR=/usr/share/ghidra \
    CYBER_GHIDRA_HOST=127.0.0.1 \
    CYBER_GHIDRA_PORT=47100 \
    CYBER_GHIDRA_STORE=/ghidra/store \
    CYBER_GHIDRA_WORKAREA=/workspace \
    CYBER_ZAP_WORKAREA=/zap/wrk \
    PYTHONUNBUFFERED=1
RUN "${CYBERFUL_OS_PYTHON_VENV}/bin/pip" install \
      --no-index \
      --find-links /usr/share/ghidra/Ghidra/Features/PyGhidra/pypkg/dist \
      pyghidra \
  && chmod 0755 /usr/local/bin/cyberful-zap /opt/cyberful/runtime-supervisor /opt/cyberful/runtime-attestation /opt/cyberful/tls-canary \
  && case "${TARGETARCH}" in \
      amd64) GHIDRA_DECOMPILER=linux_x86_64 ;; \
      arm64) GHIDRA_DECOMPILER=linux_arm_64 ;; \
      *) echo "unsupported unified runtime architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && test -x "/usr/share/ghidra/Ghidra/Features/Decompiler/os/${GHIDRA_DECOMPILER}/decompile" \
  && file "/usr/share/ghidra/Ghidra/Features/Decompiler/os/${GHIDRA_DECOMPILER}/decompile" \
      | grep -q "$(if [[ "${TARGETARCH}" == "amd64" ]]; then echo 'x86-64'; else echo 'ARM aarch64'; fi)" \
  && test -s /zap/zap-x.sh \
  && for addon in ascanrules spiderAjax authhelper graphql mcp oast openapi pscanrules reports websocket; do \
      test -n "$(find /zap/plugin -name "${addon}-*.zap" -perm -004 -print -quit)"; \
    done \
  && "${CYBERFUL_OS_PYTHON_VENV}/bin/python" /opt/cyberful/runtime-attestation

# ── Volatile Release Metadata Follows Runtime Filesystem Layers ─────────────
# BUILD_VERSION and BUILD_REVISION change for every published commit, while
# ZAP and Bun version bumps do not alter the expensive Kali toolchain layers.
# Consuming those arguments only after installation and attestation lets
# BuildKit reuse the complete runtime filesystem and regenerate only image
# metadata when the release identity changes. The final labels remain identical
# to the public OCI contract consumed by the runtime and release workflows.
# ───────────────────────────────────────────────────────────────────────────
ARG BUN_VERSION
ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.title="cyberful-os" \
      org.opencontainers.image.description="Unified Cyberful engagement runtime with cyberful-os, OWASP ZAP, and Ghidra" \
      org.opencontainers.image.source="https://github.com/cyberful/cyberful" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.cyberful.ghidra.version="${GHIDRA_VERSION}" \
      org.cyberful.zap.version="${ZAP_VERSION}" \
      org.cyberful.bun.version="${BUN_VERSION}" \
      org.cyberful.zap.addons="ascanrules=83,spiderAjax=23.32.0,authhelper=0.40.0,graphql=0.33.0,mcp=0.2.0,oast=0.24.0,openapi=57,pscanrules=75,reports=0.46.0,websocket=37"

WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT ["tini", "--", "/opt/cyberful/runtime-supervisor"]
