// ── In-Process Control-Plane Transport ──────────────────────────
// Connects the typed control-plane client directly to the default server app,
// avoiding a network listener for callers inside the Cyberful process.
// → cyberful/src/server/server.ts — owns the shared fetch application.
// ─────────────────────────────────────────────────────────────────

import { Server } from "@/server/server"
import { createControlPlaneClient, type ControlPlaneClientOptions } from "./index"

export function createLocalControlPlaneClient(options?: Omit<ControlPlaneClientOptions, "baseUrl" | "fetch">) {
  return createControlPlaneClient({
    ...options,
    baseUrl: "http://cyberful.internal",
    fetch: ((input, init) =>
      Server.Default().app.fetch(input instanceof Request ? input : new Request(input, init))) as typeof fetch,
  })
}
