// ── Built-In Gateway Upstream Registry ──────────────────────────
// Constructs the local cyberful-os, isolated browser, and optional ZAP bridge
// process descriptors from validated dependency configuration for one gateway.
// → cyberful/src/subsystem/gateway/server.ts — starts and proxies these upstreams.
// ─────────────────────────────────────────────────────────────────

import {
  cyberBrowserZapChainEnv,
  cyberBrowserMcpCommand,
  cyberfulOsDir,
  cyberfulOsMcpCommand,
  cyberZapBridgeCommand,
  cyberZapBridgeContainerName,
  shouldChainBrowserThroughZap,
  shouldEnableCyberBrowserMcp,
  shouldEnableCyberfulOsMcp,
  shouldEnableCyberZap,
} from "@/dependency/config"

export function builtin() {
  const root = cyberfulOsDir()
  const image = process.env.CYBERFUL_OS_IMAGE?.trim() || "cyberful-os:latest"
  const container = process.env.CYBERFUL_OS_CONTAINER?.trim() || "cyberful-os"
  return {
    "cyberful-os": {
      type: "local" as const,
      command: cyberfulOsMcpCommand(),
      enabled: shouldEnableCyberfulOsMcp(),
      timeout: 3_650_000,
      environment: {
        ...(root ? { CYBERFUL_OS_DIR: root } : {}),
        CYBERFUL_OS_CONTAINER: container,
        CYBERFUL_OS_IMAGE: image,
      },
    },
    // ── Browser Defaults Preserve Isolation And Human Handoff ─────────
    // The browser upstream runs a dedicated Chromium rather than the user's
    // browser, with stealth enabled to preserve ordinary target behavior during
    // authorized testing. Headed mode remains the default because CAPTCHA
    // handoff must surface that exact runtime to the human. An explicit channel
    // override may reuse an authenticated profile, while the default bundled
    // channel avoids driving or locking a personal browser profile.
    // ───────────────────────────────────────────────────────────────
    browser: {
      type: "local" as const,
      command: cyberBrowserMcpCommand(),
      enabled: shouldEnableCyberBrowserMcp(),
      timeout: 305_000,
      environment: {
        ...(root ? { CYBERFUL_OS_DIR: root } : {}),
        CYBER_BROWSER_HEADLESS: process.env.CYBER_BROWSER_HEADLESS ?? "false",
        CYBER_BROWSER_STEALTH: "true",
        CYBER_BROWSER_CHANNEL: process.env.CYBER_BROWSER_CHANNEL ?? "chromium",
        ...(shouldChainBrowserThroughZap() ? cyberBrowserZapChainEnv() : {}),
      },
    },
    // ── ZAP Exposure Requires A Live Owned Runtime ─────────────────────
    // A phase receives a disposable stdio bridge only when its host-owned ZAP
    // runtime has published a concrete container. Pentest may reuse the runtime
    // across its engagement, while AppSec workflows retain their narrower phase
    // ownership. A degraded or disabled startup contributes no ZAP upstream;
    // the browser then follows its explicit direct-traffic fallback instead of
    // exposing a bridge that cannot serve requests.
    // ──────────────────────────────────────────────────────────────
    zap: {
      type: "local" as const,
      command: cyberZapBridgeCommand(),
      container: cyberZapBridgeContainerName(),
      enabled: shouldEnableCyberZap() && Boolean(process.env.CYBER_ZAP_CONTAINER?.trim()),
      timeout: 305_000,
      environment: {},
    },
  }
}

export * as SubsystemUpstream from "./upstream"
