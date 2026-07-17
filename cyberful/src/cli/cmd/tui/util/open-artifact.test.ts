// ── Artifact Opener Contract Tests ───────────────────────────────
// Protects direct, shell-free platform commands used when users open generated
//   report artifacts from a completion card.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { openerCommands } from "./open-artifact"

describe("artifact system opener", () => {
  test("uses direct platform commands without a shell", () => {
    expect(openerCommands("darwin", "/tmp/report.pdf")).toEqual([["open", "/tmp/report.pdf"]])
    expect(openerCommands("win32", "C:\\report.pdf")).toEqual([["explorer.exe", "C:\\report.pdf"]])
    expect(openerCommands("linux", "/tmp/report.pdf")).toEqual([
      ["xdg-open", "/tmp/report.pdf"],
      ["gio", "open", "/tmp/report.pdf"],
    ])
  })
})
