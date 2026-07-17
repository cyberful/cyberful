// ── In-Process Control-Plane Client Contract Test ───────────────
// Verifies that routine local API calls reach the in-process server while
// preserving directory routing and returning the public health contract.
// → cyberful/src/server/client/local.ts — provides the tested local transport.
// ─────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { createLocalControlPlaneClient } from "./local"

test("the local control-plane client uses the in-process server", async () => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const result = await createLocalControlPlaneClient({
      directory: "/tmp/control plane",
    }).global.health({ throwOnError: true })
    const url = new URL(result.request.url)

    expect(result.response.status).toBe(200)
    expect(url.origin + url.pathname).toBe("http://cyberful.internal/global/health")
    expect(url.searchParams.get("directory")).toBe("/tmp/control plane")
    expect(result.request.headers.has("x-cyberful-directory")).toBe(false)
    expect(result.data.healthy).toBe(true)
  } finally {
    stderr.mockRestore()
  }
})
