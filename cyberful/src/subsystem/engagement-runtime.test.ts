// ── Engagement Runtime Host Requirement Tests ─────────────────
// Verifies the Docker allocation boundary independently from a live daemon so
//   startup warnings cannot silently drift below the documented requirement.
// → cyberful/src/subsystem/engagement-runtime.ts — enforces the tested warning.
// ───────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  cyberfulOsRuntimePlatform,
  dockerChildContainerName,
  dockerHostname,
  dockerMemoryAllocationWarning,
  readPersistedProxyTrust,
  requiresZapUpstream,
  zapCoreIsolationMounts,
} from "./engagement-runtime"
import { attestProxyCertificate } from "./zap/runtime"

test("requires at least ten decimal gigabytes dedicated to Docker", () => {
  expect(dockerMemoryAllocationWarning("9999999999")).toContain("at least 10 GB")
  expect(dockerMemoryAllocationWarning("10000000000")).toBeUndefined()
  expect(() => dockerMemoryAllocationWarning("unknown")).toThrow("non-decimal")
})

test("bounds derived Docker hostnames without weakening container identity", () => {
  expect(dockerHostname("cyberful-os-short")).toBe("cyberful-os-short")
  const derived = dockerHostname(`${"cyberful-os-expert-"}${"a".repeat(44)}-zap`)
  expect(derived.length).toBe(63)
  expect(derived).toMatch(/^cyberful-os-expert-[a]+-[a-f0-9]{24}$/)
  expect(derived).not.toBe(dockerHostname(`${"cyberful-os-expert-"}${"a".repeat(43)}b-zap`))

  const child = dockerChildContainerName(`${"cyberful-os-expert-"}${"b".repeat(44)}`, "zap")
  expect(child.length).toBe(63)
  expect(child).toMatch(/^cyberful-os-expert-[b]+-[a-f0-9]{24}-zap$/)
  expect(child).not.toBe(dockerChildContainerName(`${"cyberful-os-expert-"}${"b".repeat(43)}c`, "zap"))
})

test("normalizes the attested cyberful-os Linux architecture for agent prompts", () => {
  expect(cyberfulOsRuntimePlatform("Linux", "aarch64")).toBe("Linux/ARM64 (aarch64)")
  expect(cyberfulOsRuntimePlatform("linux", "x86_64")).toBe("Linux/AMD64 (x86_64)")
  expect(() => cyberfulOsRuntimePlatform("Darwin", "arm64")).toThrow("unsupported cyberful-os kernel")
  expect(() => cyberfulOsRuntimePlatform("Linux", "riscv64")).toThrow("unsupported cyberful-os architecture")
})

test("requires ZAP for every live-target phase before a numeric policy exists", () => {
  expect(requiresZapUpstream("pentest")).toBe(true)
  expect(requiresZapUpstream("bug-bounty")).toBe(true)
  expect(requiresZapUpstream("ask")).toBe(false)
  expect(requiresZapUpstream("code-audit")).toBe(false)
  expect(requiresZapUpstream("ask", { global_http_rps: 4 })).toBe(true)
  expect(
    requiresZapUpstream("ask", {
      required_http_headers: [
        { name: "X-Request-Purpose", value: "Research", hosts: ["app.example.test"] },
      ],
    }),
  ).toBe(true)
})

test("masks private ZAP state and exposes only a read-only public trust mount to the core", () => {
  expect(zapCoreIsolationMounts("/host/workarea/raw/zap/trust")).toEqual([
    "--mount",
    "type=tmpfs,destination=/workspace/raw/zap/runtime,tmpfs-size=1048576,tmpfs-mode=0700",
    "--mount",
    "type=bind,source=/host/workarea/raw/zap/trust,target=/workspace/raw/zap/trust,readonly",
    "--mount",
    "type=bind,source=/host/workarea/raw/zap/trust,target=/run/cyberful/proxy-trust,readonly",
  ])
})

test("reloads a durable proxy trust identity and rejects a replaced public certificate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-persisted-ca-"))
  try {
    const generate = (name: string) => {
      const result = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          `${name}.key`,
          "-out",
          `${name}.pem`,
          "-days",
          "1",
          "-subj",
          `/CN=${name}`,
          "-addext",
          "basicConstraints=critical,CA:TRUE",
          "-addext",
          "keyUsage=critical,keyCertSign,cRLSign",
        ],
        { cwd: directory, stderr: "pipe" },
      )
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    generate("original")
    generate("replacement")
    const original = await readFile(path.join(directory, "original.pem"), "utf8")
    const identity = attestProxyCertificate(Buffer.from(original))
    await writeFile(path.join(directory, "root-ca-public.pem"), original)
    await writeFile(
      path.join(directory, "attestation.json"),
      `${JSON.stringify({
        version: 1,
        fingerprint256: identity.fingerprint256,
        spki: identity.spki,
        bundleSha256: "a".repeat(64),
      })}\n`,
    )

    expect(await readPersistedProxyTrust(directory)).toMatchObject({
      fingerprint256: identity.fingerprint256,
      spki: identity.spki,
      bundleSha256: "a".repeat(64),
    })
    await writeFile(path.join(directory, "root-ca-public.pem"), await readFile(path.join(directory, "replacement.pem")))
    await expect(readPersistedProxyTrust(directory)).rejects.toThrow("does not match")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails closed on malformed or symlinked durable proxy trust metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-invalid-persisted-ca-"))
  try {
    const attestation = path.join(directory, "attestation.json")
    await writeFile(attestation, "{}\n")
    await expect(readPersistedProxyTrust(directory)).rejects.toThrow("invalid schema")
    await rm(attestation)
    await writeFile(path.join(directory, "outside.json"), "{}\n")
    await symlink(path.join(directory, "outside.json"), attestation)
    await expect(readPersistedProxyTrust(directory)).rejects.toThrow("regular file")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
