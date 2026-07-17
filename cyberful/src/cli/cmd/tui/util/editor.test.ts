// ── External Editor Command Tests ────────────────────────────────
// Protects the editor configurations users place in VISUAL and EDITOR so paths,
//   wait flags, and quoted arguments reach the editor without shell evaluation.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { parseEditorCommand } from "./editor"

describe("parseEditorCommand", () => {
  test("preserves routine executable flags and quoted paths", () => {
    expect(parseEditorCommand('"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" --wait')).toEqual([
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "--wait",
    ])
    expect(parseEditorCommand("nvim -f '+set spell'")).toEqual(["nvim", "-f", "+set spell"])
  })

  test("keeps Windows path separators and escaped spaces", () => {
    expect(parseEditorCommand("C:\\Tools\\editor.exe --profile work\\ files")).toEqual([
      "C:\\Tools\\editor.exe",
      "--profile",
      "work files",
    ])
  })

  test("rejects malformed configuration before process launch", () => {
    expect(() => parseEditorCommand("   ")).toThrow("must name an executable")
    expect(() => parseEditorCommand('code "unfinished')).toThrow("unterminated quote")
    expect(() => parseEditorCommand("code\0--wait")).toThrow("null byte")
  })
})
