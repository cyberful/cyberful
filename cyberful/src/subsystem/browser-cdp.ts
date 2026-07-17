// ── Live Browser CDP Endpoint Discovery ─────────────────────────
// Reads a Chromium profile's recorded debugging port and accepts it only after
// a bounded loopback probe proves that the browser is still listening.
// → cyberful/src/subsystem/gateway/server.ts — chooses pinned or temporary browser profiles.
// @docs/runtimes/browser.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import fs from "node:fs"
import net from "node:net"

// TCP-probe 127.0.0.1:port — true when a live listener answers within the timeout, false on refuse/timeout.
export function cdpPortListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const settle = (alive: boolean) => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => settle(true))
    socket.once("timeout", () => settle(false))
    socket.once("error", () => settle(false))
  })
}

// The port recorded in <profileDir>/DevToolsActivePort, but ONLY when a listener is live on it (see the
// stale-file hazard above). Returns undefined when the file is absent/garbage OR the recorded port is dead.
export async function readCdpPort(profileDir: string): Promise<number | undefined> {
  let port: number
  try {
    const raw = fs.readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8")
    port = Number.parseInt(raw.split("\n", 1)[0]?.trim() ?? "", 10)
  } catch {
    return undefined
  }
  if (!Number.isInteger(port) || port <= 0) return undefined
  return (await cdpPortListening(port)) ? port : undefined
}

export * as SubsystemBrowserCdp from "./browser-cdp"
