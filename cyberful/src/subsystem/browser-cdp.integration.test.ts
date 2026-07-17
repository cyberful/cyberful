// ── Live Browser CDP Probe Tests ─────────────────────────────────
// Verifies against real loopback sockets that stale profile port files are
// rejected and a reachable Chromium debugging listener is accepted.
// → cyberful/src/subsystem/browser-cdp.ts — performs the profile and TCP checks.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { SubsystemBrowserCdp } from "./browser-cdp"

// DevToolsActivePort outlives the browser, so a recorded port must be TCP-probed before it is trusted.
// These cases intentionally bind loopback and therefore run in the network-integration CI matrix.
describe("browser-cdp loopback", () => {
  const listen = () =>
    new Promise<{ server: net.Server; port: number }>((resolve, reject) => {
      const server = net.createServer()
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject)
        const address = server.address()
        if (!address || typeof address === "string") {
          server.close()
          reject(new Error("loopback listener returned no TCP address"))
          return
        }
        resolve({ server, port: address.port })
      })
    })

  const close = (server: net.Server) =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

  test("accepts a live debugging listener and rejects it after closure", async () => {
    const { server, port } = await listen()
    try {
      expect(await SubsystemBrowserCdp.cdpPortListening(port)).toBe(true)
    } finally {
      await close(server)
    }
    expect(await SubsystemBrowserCdp.cdpPortListening(port)).toBe(false)
  })

  test("rejects a stale debugging port recorded by an exited browser", async () => {
    const { server, port } = await listen()
    await close(server)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"))
    try {
      fs.writeFileSync(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/dead\n`)
      expect(await SubsystemBrowserCdp.readCdpPort(dir)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns the recorded port while its debugging listener is live", async () => {
    const { server, port } = await listen()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"))
    try {
      fs.writeFileSync(path.join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/live\n`)
      expect(await SubsystemBrowserCdp.readCdpPort(dir)).toBe(port)
    } finally {
      await close(server)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
