// ── ZAP Runtime Boundary Tests ───────────────────────────────────
// Verifies published proxy-port validation, local-target guidance, and disabled
// certificate behavior without requiring an external daemon.
// → cyberful/src/subsystem/zap/runtime.ts — provides shared ZAP utilities.
// ─────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { attestProxyCertificate, localTargetWarning, parsePublishedPort } from "./runtime"

let certificateDirectory = ""

function openssl(...args: string[]) {
  const result = Bun.spawnSync(["openssl", ...args], { cwd: certificateDirectory, stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "openssl fixture generation failed")
}

beforeAll(async () => {
  certificateDirectory = await mkdtemp(path.join(os.tmpdir(), "cyberful-zap-ca-"))
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "root.key",
    "-out",
    "root.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Cyberful test proxy root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  )
  openssl(
    "req",
    "-x509",
    "-key",
    "root.key",
    "-out",
    "root-reissued.pem",
    "-days",
    "1",
    "-set_serial",
    "2",
    "-subj",
    "/CN=Cyberful test proxy root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  )
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Not a CA",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
  )
  openssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "subordinate.key",
    "-out",
    "subordinate.csr",
    "-subj",
    "/CN=Signed subordinate CA",
  )
  await writeFile(
    path.join(certificateDirectory, "subordinate.ext"),
    "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
  )
  openssl(
    "x509",
    "-req",
    "-in",
    "subordinate.csr",
    "-CA",
    "root.pem",
    "-CAkey",
    "root.key",
    "-CAcreateserial",
    "-out",
    "subordinate.pem",
    "-days",
    "1",
    "-extfile",
    "subordinate.ext",
  )
})

afterAll(async () => {
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true })
})

describe("ZAP engagement runtime", () => {
  test("accepts only a concrete published loopback port", () => {
    expect(parsePublishedPort("127.0.0.1:49152\n")).toBe(49152)
    expect(parsePublishedPort("[::1]:8443")).toBe(8443)
    expect(() => parsePublishedPort("8080/tcp -> 0.0.0.0:0")).toThrow("invalid ZAP proxy mapping")
  })

  test("detects host-loopback targets without changing the supplied objective", () => {
    expect(localTargetWarning("Assess https://localhost:3000/app in scope")).toContain(
      "https://host.docker.internal:3000",
    )
    expect(localTargetWarning("Assess http://127.0.0.1:8080/api in scope")).toContain(
      "http://host.docker.internal:8080",
    )
    expect(localTargetWarning("Assess https://target.example")).toBeUndefined()
  })

  test("accepts one currently valid self-signed CA and emits public-only trust identifiers", async () => {
    const certificate = await readFile(path.join(certificateDirectory, "root.pem"))
    const attestation = attestProxyCertificate(certificate)
    expect(attestation.certificatePem).toStartWith("-----BEGIN CERTIFICATE-----")
    expect(attestation.certificatePem).not.toContain("PRIVATE KEY")
    expect(attestation.spki).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(attestation.fingerprint256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("tracks both key continuity and certificate replacement", async () => {
    const [original, reissued] = await Promise.all([
      readFile(path.join(certificateDirectory, "root.pem")),
      readFile(path.join(certificateDirectory, "root-reissued.pem")),
    ])
    const originalAttestation = attestProxyCertificate(original)
    const reissuedAttestation = attestProxyCertificate(reissued)
    expect(reissuedAttestation.spki).toBe(originalAttestation.spki)
    expect(reissuedAttestation.fingerprint256).not.toBe(originalAttestation.fingerprint256)
  })

  test("rejects non-CA, non-self-signed, expired, multiple, and private-key payloads", async () => {
    const [root, key, leaf, subordinate] = await Promise.all([
      readFile(path.join(certificateDirectory, "root.pem")),
      readFile(path.join(certificateDirectory, "root.key")),
      readFile(path.join(certificateDirectory, "leaf.pem")),
      readFile(path.join(certificateDirectory, "subordinate.pem")),
    ])
    expect(() => attestProxyCertificate(leaf)).toThrow("not a CA")
    expect(() => attestProxyCertificate(subordinate)).toThrow("self-signed")
    expect(() => attestProxyCertificate(root, new Date("2200-01-01T00:00:00Z"))).toThrow("validity window")
    const invalidSignature = Buffer.from(new X509Certificate(root).raw)
    invalidSignature[invalidSignature.length - 1] ^= 1
    expect(() => attestProxyCertificate(invalidSignature)).toThrow("self-signed")
    expect(() => attestProxyCertificate(Buffer.concat([root, root]))).toThrow("exactly one certificate")
    const rootDer = new X509Certificate(root).raw
    expect(() => attestProxyCertificate(Buffer.concat([rootDer, rootDer]))).toThrow("exactly one certificate")
    expect(() => attestProxyCertificate(Buffer.concat([root, key]))).toThrow("private key")
  })
})
