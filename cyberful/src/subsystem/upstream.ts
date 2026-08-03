// ── Built-In Gateway Upstream Registry ──────────────────────────
// Constructs local cyberful-os, browser, and in-container service bridge process
// descriptors from validated engagement configuration for one gateway.
// → cyberful/src/subsystem/gateway/server.ts — starts and proxies these upstreams.
// ─────────────────────────────────────────────────────────────────

import {
  cyberBrowserZapChainEnv,
  cyberBrowserMcpCommand,
  cyberfulOsDir,
  cyberfulOsImage,
  cyberfulOsMcpCommand,
  cyberGhidraBridgeCommand,
  cyberZapBridgeCommand,
  shouldChainBrowserThroughZap,
  shouldEnableCyberBrowserMcp,
  shouldEnableCyberGhidra,
  shouldEnableCyberfulOsMcp,
  shouldEnableCyberZap,
} from "@/dependency/config"

export function builtin() {
  const root = cyberfulOsDir()
  const image = cyberfulOsImage()
  const container = process.env.CYBERFUL_OS_CONTAINER?.trim() || "cyberful-os"
  const zapReady = shouldEnableCyberZap() && process.env.CYBER_ZAP_READY === "1"
  const ghidraReady = shouldEnableCyberGhidra() && process.env.CYBER_GHIDRA_READY === "1"
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
        ...(process.env.CYBER_BROWSER_BUN_REENTRY === "1" ? { BUN_BE_BUN: "1" } : {}),
        ...(shouldChainBrowserThroughZap() ? cyberBrowserZapChainEnv() : {}),
      },
    },
    // ── Service Exposure Requires An Attested Engagement Runtime ─────
    // The host sets each ready marker only after its loopback service and real
    // docker-exec bridge complete preflight. A degraded service contributes no
    // upstream, while every sequential phase reconnects through a fresh stdio
    // process inside the same container. No phase owns a bridge image, mount,
    // network namespace, or Docker cleanup responsibility.
    // ──────────────────────────────────────────────────────────────
    zap: {
      type: "local" as const,
      command: zapReady ? cyberZapBridgeCommand() : [],
      enabled: zapReady,
      timeout: 305_000,
      environment: {},
    },
    ghidra: {
      type: "local" as const,
      command: ghidraReady ? cyberGhidraBridgeCommand() : [],
      enabled: ghidraReady,
      timeout: 305_000,
      environment: {},
    },
  }
}

export * as SubsystemUpstream from "./upstream"
