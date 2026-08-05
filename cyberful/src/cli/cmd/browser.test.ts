// ── Browser Profile CLI Command Tests ───────────────────────────────
// Protects the exact browser-N command surface and its bounded invalid-profile
// error before any browser process or persistent state can be touched.
// → cyberful/src/cli/cmd/browser.ts — parses the tested public commands.
// @docs/user-guide/interface.md
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROFILE_COMMANDS,
  browserProfileCommandKind,
  browserProfileFromCommand,
  invalidBrowserProfileMessage,
} from "./browser"

describe("browser profile CLI command", () => {
  test("accepts every supported browser-N command", () => {
    expect(BROWSER_PROFILE_COMMANDS.map(browserProfileFromCommand)).toEqual([1, 2, 3, 4, 5])
  })

  test("rejects unsupported and malformed profile identifiers clearly", () => {
    expect(browserProfileCommandKind("browser-5")).toBe("supported")
    expect(browserProfileCommandKind("browser-6")).toBe("unsupported")
    expect(browserProfileCommandKind("project-browser-6")).toBe("unrelated")
    expect(() => browserProfileFromCommand("browser-6")).toThrow(
      "Invalid browser profile '6'. Use cyberful browser-1 through cyberful browser-5.",
    )
    expect(invalidBrowserProfileMessage("browser-account")).toBe(
      "Invalid browser profile 'account'. Use cyberful browser-1 through cyberful browser-5.",
    )
  })
})
