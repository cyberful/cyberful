// ── Tool Output Detection Tests ──────────────────────────────────
// Protects syntax selection and cyberful-os envelope parsing for outputs users see
//   while commands, source reads, and structured tools run in a session.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { cleanToolOutputText, detectToolOutputFiletype, parseCyberfulOsToolOutput } from "./tool-output-language"

describe("tool output language detection", () => {
  test("detects html output from source fetches", () => {
    expect(
      detectToolOutputFiletype(
        '<!DOCTYPE html><html lang="it"><head><meta charSet="utf-8"/></head><body></body></html>',
        {
          command: "cat /tmp/login_page.html",
        },
      ),
    ).toBe("html")
  })

  test("does not promote an envelope containing escaped html to html", () => {
    expect(
      detectToolOutputFiletype(
        'target: cyberful-os\nexit_code: 0\n\nstdout:\n{\n  "body": "\\n<!DOCTYPE html><html><body>ok</body></html>"\n}',
      ),
    ).not.toBe("html")
  })

  test("detects structured data and patches", () => {
    expect(detectToolOutputFiletype('{"ok":true,"items":[1,2,3]}')).toBe("json")
    expect(detectToolOutputFiletype('[{"name":"cyberful"}]')).toBe("json")
    expect(detectToolOutputFiletype("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new")).toBe("diff")
  })

  test("detects common code snippets", () => {
    expect(
      detectToolOutputFiletype("curl -s https://example.com | jq .", { command: "curl -s https://example.com" }),
    ).toBe("bash")
    expect(detectToolOutputFiletype("const total = items.map((item) => item.value).length")).toBe("typescript")
    expect(detectToolOutputFiletype("def main():\n    print('hello')")).toBe("python")
    expect(detectToolOutputFiletype(".button {\n  color: red;\n}")).toBe("css")
  })

  test("recognizes markdown containing session-variable templates", () => {
    const markdown = [
      "# Recon Notes",
      "",
      "> Status: in progress. Secrets use `{{var:name}}`.",
      "",
      "## Owned slice",
      "- Requests remain sequential; use `{{var:request_user_agent}}`.",
    ].join("\n")

    expect(detectToolOutputFiletype(markdown)).toBe("markdown")
  })

  test("keeps prose and logs unclassified", () => {
    expect(
      detectToolOutputFiletype("http://app.lexroom.ai [200 OK]\nERROR Opening: http://api.lexroom.ai"),
    ).toBeUndefined()
    expect(detectToolOutputFiletype("bash completed · 2s")).toBeUndefined()
  })

  test("cleans ansi and terminal control characters", () => {
    expect(cleanToolOutputText("\x1b[35mhello\x1b[0m\rworld\x08")).toBe("hello\nworld")
  })

  test("splits cyberful-os metadata and omits an empty stderr section", () => {
    expect(
      parseCyberfulOsToolOutput(
        "target: cyberful-os\nexit_code: 0\nduration_ms: 12\ntimed_out: false\ntruncated: false\n\nstdout:\nPASS\n\nstderr:\n",
      ),
    ).toEqual({
      metadata: [
        { key: "target", value: "cyberful-os" },
        { key: "exit_code", value: "0" },
        { key: "duration_ms", value: "12" },
        { key: "timed_out", value: "false" },
        { key: "truncated", value: "false" },
      ],
      stdout: "PASS",
    })
  })

  test("preserves non-empty cyberful-os stderr", () => {
    expect(
      parseCyberfulOsToolOutput("target: cyberful-os\nexit_code: 1\n\nstdout:\n\nstderr:\nconnection refused\n")?.stderr,
    ).toBe("connection refused")
  })
})
