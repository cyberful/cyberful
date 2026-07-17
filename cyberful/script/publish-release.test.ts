// ── npm Integrity Comparison Contract ───────────────────────────────
// Verifies local tarballs use npm's stable SHA-512 integrity representation
// and that release recovery distinguishes an absent package from registry
// failures before deciding whether publication is safe.
// → scripts/publish-npm.ts — performs the idempotent publication check.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { npmIntegrity, publishedIntegrity } from "../../scripts/publish-npm"

const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

describe("partial release integrity", () => {
  test("uses npm's sha512 integrity format", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-integrity-"))
    temporaryRoots.push(root)
    const file = path.join(root, "package.tgz")
    fs.writeFileSync(file, "cyberful")
    const first = await npmIntegrity(file)
    expect(first).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
    expect(await npmIntegrity(file)).toBe(first)
  })

  test("publishes only after npm explicitly reports that a package is absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-npm-view-"))
    temporaryRoots.push(root)
    const npm = path.join(root, "npm")
    await Bun.write(
      npm,
      `#!/usr/bin/env bun
const target = process.argv[3] ?? ""
if (target.includes("missing")) {
  console.error("npm error code E404")
  process.exit(1)
}
if (target.includes("outage")) {
  console.error("npm error code ECONNRESET")
  process.exit(1)
}
if (target.includes("malformed")) {
  console.log("{")
  process.exit(0)
}
console.log(JSON.stringify("sha512-Y3liZXJmdWw="))
`,
    )
    fs.chmodSync(npm, 0o755)

    expect(publishedIntegrity("@cyberful/exists", "1.2.3", npm)).toBe("sha512-Y3liZXJmdWw=")
    expect(publishedIntegrity("@cyberful/missing", "1.2.3", npm)).toBeUndefined()
    expect(() => publishedIntegrity("@cyberful/outage", "1.2.3", npm)).toThrow("ECONNRESET")
    expect(() => publishedIntegrity("@cyberful/malformed", "1.2.3", npm)).toThrow("invalid JSON")
  })
})
