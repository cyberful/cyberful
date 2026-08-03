// ── ZAP Runtime Boundary Utilities ───────────────────────────────
// Validates the host-facing proxy descriptor and derives browser trust material
//   while unified container ownership remains outside this module.
// → cyberful/src/subsystem/engagement-runtime.ts — owns ZAP's service lifecycle.
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

import { createHash, X509Certificate } from "node:crypto"

export function localTargetWarning(objective: string) {
  const target = objective
    .match(/https?:\/\/[^\s<>()"']+/gi)
    ?.map((value) => {
      try {
        return new URL(value.replace(/[.,;:!?]+$/, ""))
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        return undefined
      }
    })
    .find((value) => value && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(value.hostname))
  if (!target) return
  const corrected = new URL(target)
  corrected.hostname = "host.docker.internal"
  return (
    `The target ${target.origin} is host loopback, which resolves inside the ZAP container. ` +
    `Use ${corrected.origin} when that preserves the application's Host, cookie, redirect, and origin semantics; ` +
    "Cyberful will not rewrite it automatically."
  )
}

export function parsePublishedPort(value: string) {
  const port = Number.parseInt(
    value
      .trim()
      .split("\n")[0]
      ?.match(/:(\d+)$/)?.[1] ?? "",
    10,
  )
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) throw new Error(`invalid ZAP proxy mapping: ${value}`)
  return port
}

export function spkiFromCertificate(value: Uint8Array) {
  const certificate = new X509Certificate(value)
  const publicKey = certificate.publicKey.export({ type: "spki", format: "der" })
  return createHash("sha256").update(publicKey).digest("base64")
}

export * as SubsystemZapRuntime from "./runtime"
