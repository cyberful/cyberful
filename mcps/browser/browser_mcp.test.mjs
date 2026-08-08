// ── Browser MCP Boundary Contract ──────────────────────────────────
// Exercises malformed tool calls, bounded stdio framing, artifact confinement,
// and response-size proofs through the same entrypoints used by MCP clients.
// A rejected request must not launch Chromium or read an unbounded payload.
// → mcps/browser/browser_mcp.mjs — validates and dispatches browser tool calls.
// ────────────────────────────────────────────────────────────────────

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterAll, describe, expect, test } from "bun:test"

const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-mcp-"))
const outsideDir = await mkdtemp(path.join(os.tmpdir(), "cyberful-browser-outside-"))
const previousArtifactsDir = process.env.CYBER_BROWSER_ARTIFACTS_DIR
process.env.CYBER_BROWSER_ARTIFACTS_DIR = artifactsDir
const {
  boundedJsonLines,
  browserToolDefinitions,
  captchaAssessment,
  captureSnapshotDocument,
  createSerialRequestDispatcher,
  envBool,
  formatSnapshot,
  handleToolCall,
  readBoundedResponseBody,
} = await import(`./browser_mcp.mjs?boundary-test=${Date.now()}`)
if (previousArtifactsDir === undefined) delete process.env.CYBER_BROWSER_ARTIFACTS_DIR
else process.env.CYBER_BROWSER_ARTIFACTS_DIR = previousArtifactsDir

afterAll(async () => {
  await Promise.all([
    rm(artifactsDir, { force: true, recursive: true }),
    rm(outsideDir, { force: true, recursive: true }),
  ])
})

describe("browser MCP input boundary", () => {
  test("publishes one strict schema for every dispatchable browser tool", () => {
    const definitions = browserToolDefinitions()
    const names = definitions.map((tool) => tool.name)

    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain("browser_status")
    expect(names).toContain("browser_navigate")
    expect(names).toContain("browser_click")
    expect(names).toContain("browser_evaluate")
    expect(names).toContain("browser_artifact_read")
    expect(names).toContain("browser_close")
    const snapshot = definitions.find((tool) => tool.name === "browser_snapshot")
    expect(snapshot?.inputSchema.properties.max_elements.maximum).toBe(500)
    expect(snapshot?.inputSchema.properties.max_text_chars.maximum).toBe(100_000)
    expect(snapshot?.inputSchema.properties.selector).toMatchObject({ type: "string", minLength: 1 })
    expect(snapshot?.inputSchema.properties.text_offset).toMatchObject({ type: "integer", minimum: 0, default: 0 })
    for (const tool of definitions) {
      expect(tool.name.startsWith("browser_")).toBe(true)
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })

  test("attaches redacted action metadata without browser inputs", async () => {
    const result = await handleToolCall({ name: "browser_status", arguments: {} })
    const metadata = result._meta?.["cyberful.dev/browser-action"]

    expect(metadata).toMatchObject({
      profile: 1,
      page_id: "none",
      action: "browser_status",
      action_family: "browser",
      page_transition: "none",
      outcome: "ok",
    })
    expect(JSON.stringify(metadata)).not.toContain("selector")
    expect(JSON.stringify(metadata)).not.toContain("cookie")
  })

  test("rejects malformed schema values before a browser action starts", async () => {
    const wrongType = await handleToolCall({
      name: "browser_wait",
      arguments: { milliseconds: "10" },
    })
    const unknownField = await handleToolCall({
      name: "browser_status",
      arguments: { unexpected: true },
    })

    expect(wrongType.isError).toBe(true)
    expect(wrongType.content[0].text).toContain("arguments.milliseconds: expected an integer")
    expect(unknownField.isError).toBe(true)
    expect(unknownField.content[0].text).toContain("unknown property unexpected")
  })

  test("accepts explicit environment booleans and rejects ambiguous values", () => {
    const name = "CYBERFUL_BROWSER_BOOLEAN_TEST"
    const previous = process.env[name]
    try {
      process.env[name] = " yes "
      expect(envBool(name, false)).toBe(true)
      process.env[name] = "sometimes"
      expect(() => envBool(name, false)).toThrow("must be one of")
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  })

  test("drops an oversized stdio frame and resumes at the next request", async () => {
    const input = Readable.from([Buffer.from("1234"), Buffer.from("56789\n{}\n")])
    const records = []
    for await (const record of boundedJsonLines(input, 8)) records.push(record)

    expect(records).toEqual([{ error: "input line exceeds 8 bytes" }, { line: "{}" }])
  })

  test("cancellation interrupts the active MCP request and releases the profile queue", async () => {
    const events = []
    const dispatcher = createSerialRequestDispatcher({
      handle: async (message) => {
        events.push(`start:${message.id}`)
        if (message.id === 1) await new Promise(() => {})
        events.push(`finish:${message.id}`)
      },
      onCancel: (reason) => {
        events.push(`cancel:${reason}`)
      },
    })

    dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })
    await Promise.resolve()
    dispatcher.dispatch({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, reason: "deadline" },
    })
    dispatcher.dispatch({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })
    await dispatcher.drain()

    expect(events).toEqual(["start:1", "cancel:deadline", "start:2", "finish:2"])
  })
})

describe("CAPTCHA evidence assessment", () => {
  test("keeps provider SDK traffic and response fields diagnostic-only", () => {
    expect(
      captchaAssessment([
        { provider: "hcaptcha", kind: "network", evidence: "https://js.hcaptcha.com/1/api.js" },
        { provider: "hcaptcha", kind: "response_field", visible: true },
      ]),
    ).toEqual({ detected: false, confidence: "low" })
  })

  test("detects a visible provider challenge", () => {
    expect(captchaAssessment([{ provider: "hcaptcha", kind: "iframe", visible: true }])).toEqual({
      detected: true,
      confidence: "high",
    })
  })

  test("treats visible human-verification text as medium-confidence evidence", () => {
    expect(
      captchaAssessment([
        { provider: "generic", kind: "text", evidence: "verify you are human", visible: true },
      ]),
    ).toEqual({
      detected: true,
      confidence: "medium",
    })
  })

  test("does not treat a lone CAPTCHA mention as an active challenge", () => {
    expect(
      captchaAssessment([{ provider: "generic", kind: "text", evidence: "captcha", visible: true }]),
    ).toEqual({
      detected: false,
      confidence: "low",
    })
  })
})

// ── Scoped Snapshots Stay Bounded And Deterministic ─────────────────
// A small DOM double exercises the page-side snapshot function directly. This
// proves text pagination and ref ownership without launching Chromium in the
// input-boundary suite. The fixture also keeps outside controls present so a
// passing test demonstrates subtree isolation rather than an empty-page shortcut.
// ────────────────────────────────────────────────────────────────────

function fakeElement(tagName, innerText, attributes = {}) {
  const values = new Map(Object.entries(attributes))
  return {
    tagName: tagName.toUpperCase(),
    innerText,
    textContent: innerText,
    labels: [],
    href: values.get("href") || "",
    value: values.get("value") || "",
    childrenForSnapshot: [],
    getAttribute(name) {
      return values.get(name) ?? null
    },
    setAttribute(name, value) {
      values.set(name, String(value))
    },
    removeAttribute(name) {
      values.delete(name)
    },
    matches(selector) {
      if (selector.includes("button") && this.tagName === "BUTTON") return true
      if (selector.includes("a[href]") && this.tagName === "A" && values.has("href")) return true
      return false
    },
    querySelectorAll() {
      return this.childrenForSnapshot
    },
    getBoundingClientRect() {
      return { x: 1, y: 2, width: 80, height: 20 }
    },
  }
}

function withSnapshotDom(run) {
  const inside = fakeElement("button", "Open policy", { "aria-label": "Open policy" })
  const outside = fakeElement("a", "Outside", {
    href: "https://outside.example/",
    "data-cyber-browser-ref": "stale",
  })
  const firstScope = fakeElement("section", "0123456789")
  firstScope.childrenForSnapshot = [inside]
  const secondScope = fakeElement("section", "not selected")
  secondScope.childrenForSnapshot = [outside]
  const body = fakeElement("body", "whole document")
  body.childrenForSnapshot = [inside, outside]
  const fakeDocument = {
    body,
    documentElement: body,
    title: "Policy",
    querySelectorAll(selector) {
      if (selector === "[data-cyber-browser-ref]") return [outside]
      if (selector === "#policy") return [firstScope, secondScope]
      if (selector === "#missing") return []
      if (selector === "[") throw new SyntaxError("invalid selector")
      return []
    },
  }
  const fakeWindow = {
    location: { href: "https://example.test/policy" },
    getComputedStyle() {
      return { visibility: "visible", display: "block", opacity: "1" }
    },
  }
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  try {
    globalThis.document = fakeDocument
    globalThis.window = fakeWindow
    return run({ body, firstScope, inside, outside })
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

describe("browser snapshot scoping", () => {
  test("confines text and refs to the first selector match", () => {
    withSnapshotDom(({ inside, outside }) => {
      const snapshot = captureSnapshotDocument({
        maxTextChars: 4,
        maxElements: 10,
        selector: "#policy",
        textOffset: 3,
      })

      expect(snapshot).toMatchObject({
        selector: "#policy",
        selectorMatchCount: 2,
        text: "3456",
        textStart: 3,
        textEnd: 7,
        totalTextChars: 10,
        nextTextOffset: 7,
        textTruncated: true,
        totalInteractiveElements: 1,
        elementsTruncated: false,
      })
      expect(snapshot.elements.map((element) => element.name)).toEqual(["Open policy"])
      expect(inside.getAttribute("data-cyber-browser-ref")).toBe("e1")
      expect(outside.getAttribute("data-cyber-browser-ref")).toBeNull()

      const rendered = formatSnapshot(snapshot)
      expect(rendered).toContain("scope: selector \"#policy\"")
      expect(rendered).toContain("visible_text_range: 3-7/10")
      expect(rendered).toContain("next_text_offset: 7")
      expect(rendered).toContain("truncated: true")
    })
  })

  test("paginates selected text without overlaps or gaps", () => {
    withSnapshotDom(() => {
      const page = (textOffset) =>
        captureSnapshotDocument({
          maxTextChars: 4,
          maxElements: 1,
          selector: "#policy",
          textOffset,
        })
      const snapshots = [page(0), page(4), page(8)]

      expect(snapshots.map((snapshot) => snapshot.text).join("")).toBe("0123456789")
      expect(snapshots.map((snapshot) => snapshot.nextTextOffset)).toEqual([4, 8, null])
      expect(snapshots[2]).toMatchObject({ textStart: 8, textEnd: 10, textTruncated: false })
    })
  })

  test("reports document scope and rejects missing or invalid selectors", () => {
    withSnapshotDom(() => {
      const documentSnapshot = captureSnapshotDocument({
        maxTextChars: 100,
        maxElements: 10,
        selector: null,
        textOffset: 0,
      })
      expect(documentSnapshot).toMatchObject({
        selector: null,
        selectorMatchCount: 1,
        text: "whole document",
      })

      expect(() =>
        captureSnapshotDocument({
          maxTextChars: 100,
          maxElements: 10,
          selector: "#missing",
          textOffset: 0,
        }),
      ).toThrow("selector matched no elements")
      expect(() =>
        captureSnapshotDocument({
          maxTextChars: 100,
          maxElements: 10,
          selector: "[",
          textOffset: 0,
        }),
      ).toThrow("selector is invalid")
    })
  })
})

describe("browser MCP retained data", () => {
  test("returns only the requested artifact prefix", async () => {
    await writeFile(path.join(artifactsDir, "evidence.txt"), "daily evidence")

    const result = await handleToolCall({
      name: "browser_artifact_read",
      arguments: { path: "evidence.txt", max_bytes: 5 },
    })

    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0].text).truncated).toBe(true)
    expect(result.content[1].text).toBe("daily\n[truncated]\n")
  })

  test("refuses an artifact symlink that resolves outside the artifact root", async () => {
    const outside = path.join(outsideDir, "private.txt")
    await writeFile(outside, "must not escape")
    await symlink(outside, path.join(artifactsDir, "escape.txt"))

    const result = await handleToolCall({
      name: "browser_artifact_read",
      arguments: { path: "escape.txt", max_bytes: 32 },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("artifact reads are restricted")
    expect(result.content[0].text).not.toContain("must not escape")
  })

  test("rejects a declared oversized response before requesting its body", async () => {
    let bodyRead = false
    const response = {
      body: async () => {
        bodyRead = true
        return Buffer.alloc(9)
      },
      headers: () => ({ "content-length": "9" }),
      request: () => ({ method: () => "GET" }),
      status: () => 200,
    }

    await expect(readBoundedResponseBody(response, 8)).rejects.toThrow("exceeding this call's 8-byte budget")
    expect(bodyRead).toBe(false)
  })
})
