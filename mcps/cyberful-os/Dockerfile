# syntax=docker/dockerfile:1.7

ARG KALI_BASE_IMAGE=kalilinux/kali-rolling@sha256:82c8e267c5b46031c6671f7dc8a30b240dabdc7d129e07ac9290ec06dac9b93c
FROM ${KALI_BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive
ENV TORRC=/etc/tor/torrc
ENV CYBERFUL_OS_PYTHON_VENV=/opt/cyberful-os-venv
ENV PATH="${CYBERFUL_OS_PYTHON_VENV}/bin:${PATH}"

ARG JEB_INSTALLER_URL=""
ARG JEB_SHA256=""

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
    ruby \
    screen \
    socat \
    tmux \
    unzip \
    vim \
    wget \
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
    ghidra \
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
    socialscan

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
COPY --chmod=0644 wordlists/*.txt /usr/share/wordlists/cyberful-os/credentials/
COPY --chmod=0644 wordlists/content/*.txt /usr/share/wordlists/cyberful-os/content/
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
    python3 -m venv /opt/prowler-venv \
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

ARG JAZZER_RELEASE=0.30.0
ARG JAZZER_LINUX_AMD64_SHA256=6eeaf0026d75599b07527d93b576593ce847cfca8b337a579971a5a9cdf792d0
ARG JAZZER_LINUX_ARM64_SHA256=16636a4d3e98f1d3a7fcf59d4ab37f5be1d1ad6df9d94d5c3ca8de644838e369
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
  && apt-get install -y --no-install-recommends \
    afl++ \
    build-essential \
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
COPY cyberful_os_mcp.py /opt/cyberful-os/cyberful_os_mcp.py
COPY prowler_offline.py /usr/local/bin/prowler
RUN chmod 0755 /usr/local/bin/prowler \
  && python3 /opt/cyberful-os/cyberful_os_mcp.py --verify-capabilities \
  && nuclei -version \
  && semgrep --version \
  && syft version \
  && grype version \
  && gitleaks version \
  && prowler -v \
  && kubectl version --client=true \
  && kube-bench version \
  && jazzer --version \
  && (afl-fuzz -h > /tmp/afl-help 2>&1 || [[ "$?" -eq 1 ]]) \
  && grep -q "afl-fuzz \[ options \]" /tmp/afl-help \
  && rm -f /tmp/afl-help \
  && clang --version \
  && msfconsole -q -x 'version; exit'

WORKDIR /workspace
CMD ["sleep", "infinity"]
