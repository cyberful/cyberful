// ── Installed npm Launcher Contract ─────────────────────────────────
// Verifies supported Node platforms resolve the correct package target and
// that launcher discovery finds a staged executable from a real package layout.
// → cyberful/bin/resolve.cjs — selects and locates the installed binary.
// ────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

type Resolver = {
  architectureName(architecture: string): string | undefined
  findBinary(start: string, packageName: string, binaryName: string): string | undefined
  platformName(platform: string): string | undefined
  target(
    platform: string,
    architecture: string,
    musl?: boolean,
    avx2?: boolean,
  ): { packageName: string; binaryName: string } | undefined
}

function isResolver(value: unknown): value is Resolver {
  return (
    typeof value === "object" &&
    value !== null &&
    "architectureName" in value &&
    typeof value.architectureName === "function" &&
    "findBinary" in value &&
    typeof value.findBinary === "function" &&
    "platformName" in value &&
    typeof value.platformName === "function" &&
    "target" in value &&
    typeof value.target === "function"
  )
}

const loadedResolver: unknown = createRequire(import.meta.url)("../bin/resolve.cjs")
if (!isResolver(loadedResolver)) throw new Error("npm launcher must export the resolver contract")
const resolver = loadedResolver
const temporaryRoots: string[] = []

afterEach(() => {
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
})

describe("npm launcher", () => {
  test("maps supported Node platforms to public package names", () => {
    expect(resolver.platformName("win32")).toBe("windows")
    expect(resolver.architectureName("x64")).toBe("x64")
    expect(resolver.platformName("freebsd")).toBeUndefined()
    expect(resolver.target("darwin", "arm64", false)).toEqual({
      packageName: "@cyberful/cli-darwin-arm64",
      binaryName: "cyberful",
    })
    expect(resolver.target("linux", "arm64", false)).toBeUndefined()
    expect(resolver.target("linux", "x64", true)).toBeUndefined()
  })

  test("uses the Windows executable suffix", () => {
    expect(resolver.target("windows", "x64", false, true)).toEqual({
      packageName: "@cyberful/cli-windows-x64",
      binaryName: "cyberful.exe",
    })
  })

  test("selects the baseline x64 binary when AVX2 is unavailable", () => {
    expect(resolver.target("linux", "x64", false, true)?.binaryName).toBe("cyberful")
    expect(resolver.target("linux", "x64", false, false)?.binaryName).toBe("cyberful-baseline")
    expect(resolver.target("windows", "x64", false, false)?.binaryName).toBe("cyberful-baseline.exe")
  })

  test("finds scoped platform packages above the launcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberful-launcher-"))
    temporaryRoots.push(root)
    const binary = path.join(root, "node_modules", "@cyberful", "cli-linux-x64", "bin", "cyberful")
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, "binary")
    expect(
      resolver.findBinary(
        path.join(root, "node_modules", "@cyberful", "cli", "bin"),
        "@cyberful/cli-linux-x64",
        "cyberful",
      ),
    ).toBe(binary)
  })
})
