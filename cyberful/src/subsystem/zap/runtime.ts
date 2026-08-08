// ── ZAP Runtime Boundary Utilities ───────────────────────────────
// Validates the host-facing proxy descriptor and derives browser trust material
//   while unified container ownership remains outside this module.
// → cyberful/src/subsystem/engagement-runtime.ts — owns ZAP's service lifecycle.
// @docs/runtimes/zap.md
// ─────────────────────────────────────────────────────────────────

import { createHash, X509Certificate } from "node:crypto"

export const CORE_PROXY_TRUST_DIRECTORY = "/run/cyberful/proxy-trust"
export const CORE_PROXY_CA_CERTIFICATE = `${CORE_PROXY_TRUST_DIRECTORY}/root-ca-public.pem`
export const CORE_PROXY_CA_BUNDLE = `${CORE_PROXY_TRUST_DIRECTORY}/ca-bundle.pem`
export const CORE_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"

export interface ProxyCertificateAttestation {
  readonly certificatePem: string
  readonly fingerprint256: string
  readonly spki: string
}

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

// ── ZAP Exports Public Trust Material, Never Its Private Key ─────
// The API normally returns one DER certificate. PEM remains accepted for
// compatibility, but only when it contains exactly one certificate and no
// private-key block. The root must be a currently valid self-signed CA before
// its public bytes can enter the engagement-scoped core trust bundle.
// ─────────────────────────────────────────────────────────────────
export function attestProxyCertificate(
  value: Uint8Array,
  now = new Date(),
): ProxyCertificateAttestation {
  if (value.byteLength === 0) throw new Error("ZAP root CA export is empty")
  const text = Buffer.from(value).toString("utf8")
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text))
    throw new Error("ZAP root CA export unexpectedly contains private key material")
  const pemCertificates = text.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0
  if (pemCertificates > 1) throw new Error("ZAP root CA export must contain exactly one certificate")

  const certificate = new X509Certificate(value)
  if (pemCertificates === 0 && certificate.raw.byteLength !== value.byteLength)
    throw new Error("ZAP root CA export must contain exactly one certificate")
  if (!certificate.ca) throw new Error("ZAP root CA export is not a CA certificate")
  const validFrom = new Date(certificate.validFrom)
  const validTo = new Date(certificate.validTo)
  if (!Number.isFinite(validFrom.valueOf()) || !Number.isFinite(validTo.valueOf()))
    throw new Error("ZAP root CA export has an invalid validity window")
  if (now < validFrom || now > validTo) throw new Error("ZAP root CA export is outside its validity window")
  if (!certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey))
    throw new Error("ZAP root CA export is not a valid self-signed root")

  return {
    certificatePem: `${certificate.toString().trim()}\n`,
    fingerprint256: createHash("sha256").update(certificate.raw).digest("hex"),
    spki: spkiFromCertificate(certificate.raw),
  }
}

export * as SubsystemZapRuntime from "./runtime"
