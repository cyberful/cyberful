// ── Session Variable Behavior Tests ──────────────────────────────────────
// Verifies redaction, template resolution, validation, and secret-safe event payloads.
// → cyberful/src/session/variable.ts — owns the tested variable store.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SessionVariable } from "./variable"
import { MessageID } from "./schema"

function variable(name: string, value: SessionVariable.Value): SessionVariable.Info {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value
  return {
    name: SessionVariable.Name.make(name),
    value,
    type,
    size: text.length,
    preview: `<redacted:${type}:${text.length} chars>`,
  }
}

describe("SessionVariable", () => {
  test("redacts saved values from text without replacing tiny common values", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    const output = SessionVariable.redactText(
      `Authorization: Bearer ${token}\njson=${JSON.stringify(token)}\nsmall=ok`,
      [variable("admin_jwt", token), variable("short", "ok")],
    )

    expect(output).toContain("[redacted:variable:admin_jwt]")
    expect(output).not.toContain(token)
    expect(output).toContain("small=ok")
  })

  test("redacts long string values nested inside saved JSON", () => {
    const token = "nested.access.token.value"
    const output = SessionVariable.redactText(`Authorization: Bearer ${token}`, [
      variable("login_response", { access_token: token, expires_in: 3600 }),
    ])

    expect(output).toBe("Authorization: Bearer [redacted:variable:login_response]")
  })

  test("keeps variable context compact and value-free", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    const { value: _, ...summary } = variable("admin_jwt", token)
    const context = SessionVariable.systemContext([summary])

    expect(context).toContain("admin_jwt")
    expect(context).toContain("{{var:name}}")
    expect(context).not.toContain(token)
  })

  test("keeps variable context guidance when no variables are saved", () => {
    const context = SessionVariable.systemContext([])

    expect(context).toContain("Session variable store:")
    expect(context).toContain("{{var:name}}")
    expect(context).toContain("<session_variables>\n- No session variables saved yet.\n</session_variables>")
  })

  test("freezes variable context snapshot within the same user turn", () => {
    const userID = MessageID.make("msg_001")
    const snapshot = SessionVariable.freezeSystemContextSnapshot(undefined, {
      userID,
      context: "first context",
    })
    const updated = SessionVariable.freezeSystemContextSnapshot(snapshot, {
      userID,
      context: "updated context",
    })

    expect(updated).toBe(snapshot)
    expect(updated.context).toBe("first context")
  })

  test("refreshes variable context snapshot for the next user turn", () => {
    const snapshot = SessionVariable.freezeSystemContextSnapshot(undefined, {
      userID: MessageID.make("msg_001"),
      context: "first context",
    })
    const updated = SessionVariable.freezeSystemContextSnapshot(snapshot, {
      userID: MessageID.make("msg_002"),
      context: "updated context",
    })

    expect(updated).not.toBe(snapshot)
    expect(updated.context).toBe("updated context")
  })

  test("redacts set tool input before it is kept in message history", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    const input = SessionVariable.redactToolInput({
      action: "set",
      name: "admin_jwt",
      value: token,
      description: "admin bearer token",
    })

    expect(input.value).toBe("[redacted:variable:admin_jwt]")
    expect(JSON.stringify(input)).not.toContain(token)
  })

  test("resolves variable templates inside tool arguments", () => {
    const values = new Map<string, SessionVariable.Value>([
      ["admin_jwt", "jwt-token-value"],
      ["login_response", { access_token: "jwt-token-value", expires_in: 3600 }],
    ])

    const output = SessionVariable.resolveTemplateReferences(
      {
        headers: {
          Authorization: "Bearer {{var:admin_jwt}}",
        },
        body: "{{var:login_response}}",
      },
      (name) => values.get(name),
    )

    expect(output).toEqual({
      headers: {
        Authorization: "Bearer jwt-token-value",
      },
      body: { access_token: "jwt-token-value", expires_in: 3600 },
    })
  })

  test("resolves a composed browser marker before the action reaches the browser", () => {
    // Regression from the real ZAP smoke run: browser_marker was saved as a prefix reference plus a
    // timestamp. Resolving only the outer token sent the inner {{var:browser_marker_prefix}} literally
    // to example.com, defeating the marker/history correlation this value was created for.
    const store: Record<string, SessionVariable.Value> = {
      browser_marker_prefix: "cyberful-browser-",
      browser_marker: "{{var:browser_marker_prefix}}20260715T153737785Z",
    }

    expect(
      SessionVariable.resolveToolArguments(
        "browser_navigate",
        { url: "https://example.com/?{{var:browser_marker}}" },
        (name) => store[name],
      ).args,
    ).toEqual({ url: "https://example.com/?cyberful-browser-20260715T153737785Z" })
  })

  test("rejects direct and indirect variable cycles before resolving an action", () => {
    const direct: Record<string, SessionVariable.Value> = { marker: "{{var:marker}}" }
    expect(() =>
      SessionVariable.resolveToolArguments("browser_navigate", { url: "{{var:marker}}" }, (name) => direct[name]),
    ).toThrow(SessionVariable.TemplateVariableCycleError)

    const indirect: Record<string, SessionVariable.Value> = {
      marker: "{{var:prefix}}-timestamp",
      prefix: "{{var:marker}}",
    }
    expect(() =>
      SessionVariable.resolveToolArguments("browser_navigate", { url: "{{var:marker}}" }, (name) => indirect[name]),
    ).toThrow("marker -> prefix -> marker")
  })

  test("allows sixteen nested references and rejects a deeper expansion", () => {
    const chain = (length: number): Record<string, SessionVariable.Value> =>
      Object.fromEntries(
        Array.from({ length }, (_, index) => [
          `marker_${index}`,
          index === length - 1 ? "resolved" : `{{var:marker_${index + 1}}}`,
        ]),
      )

    const allowed = chain(16)
    expect(SessionVariable.resolveTemplateReferences("{{var:marker_0}}", (name) => allowed[name])).toBe("resolved")

    const tooDeep = chain(17)
    expect(() => SessionVariable.resolveTemplateReferences("{{var:marker_0}}", (name) => tooDeep[name])).toThrow(
      SessionVariable.TemplateVariableDepthError,
    )
  })

  test("fails unresolved variable templates", () => {
    expect(() => SessionVariable.resolveTemplateReferences("{{var:missing}}", () => undefined)).toThrow(
      SessionVariable.MissingTemplateVariableError,
    )
  })

  test("unusableValueReason rejects nullish/empty/coercion-sentinel values, accepts real ones", () => {
    // The garbage a failed extraction serializes to — each must be refused at the write boundary.
    for (const bad of [null, undefined, "", "   ", "undefined", "UNDEFINED", "null", "NaN", "[object Object]"]) {
      expect(typeof SessionVariable.unusableValueReason(bad)).toBe("string")
    }
    // Real values, including falsy-looking-but-legitimate ones ("0", "false", empty-looking structures).
    for (const ok of ["mark@park.io", "0", "false", "a-real-token", 42, { k: "v" }]) {
      expect(SessionVariable.unusableValueReason(ok)).toBeUndefined()
    }
  })

  test("refuses to resolve a saved-but-garbage variable, but still resolves a real one", () => {
    // Backstop for legacy rows / any write path that bypassed the set-time guard: a stored "undefined"
    // must throw, not substitute the literal string into the tool argument.
    expect(() => SessionVariable.resolveTemplateReferences("{{var:email}}", () => "undefined")).toThrow(
      SessionVariable.UnusableTemplateVariableError,
    )
    expect(SessionVariable.resolveTemplateReferences("{{var:email}}", () => "mark@park.io")).toBe("mark@park.io")
  })

  test("resolveTemplatesLenient substitutes usable vars and leaves the rest as raw tokens", () => {
    // The report-render backstop: unlike the strict path it must never throw — a missing/garbage var stays
    // a raw {{var:...}} token (reported for logging) so the client PDF is never dropped over one gap.
    const store: Record<string, string> = { target_app_url: "https://app.contractbot.ai", empty: "" }
    const md = "app {{var:target_app_url}} / missing {{var:nope}} / garbage {{var:empty}}"
    const { text, unresolved } = SessionVariable.resolveTemplatesLenient(md, (n) => store[n])
    expect(text).toBe("app https://app.contractbot.ai / missing {{var:nope}} / garbage {{var:empty}}")
    expect(unresolved.sort()).toEqual(["empty", "nope"])
  })

  test("resolveToolArguments: write.content is lenient (unsaved var stays literal, saved var resolves)", () => {
    // A document rewrite may preserve literal text that explains the {{var:...}} convention.
    // (an unsaved {{var:name}}). Strict resolution aborted the whole RECON.md write over that one token;
    // content must instead keep it literal while still substituting a real saved token.
    const store: Record<string, SessionVariable.Value> = { app_bearer_token: "real-token" }
    const { args, unresolved } = SessionVariable.resolveToolArguments(
      "write",
      { filePath: "/w/RECON.md", content: "notes say {{var:name}}; auth {{var:app_bearer_token}}" },
      (name) => store[name],
    )
    expect(args.content).toBe("notes say {{var:name}}; auth real-token")
    expect(args.filePath).toBe("/w/RECON.md")
    expect(unresolved).toEqual(["name"])
  })

  test("resolveToolArguments: non-content fields stay strict — a missing var in write.filePath throws", () => {
    // filePath is an action argument, not prose: a literal {{var}} reaching the filesystem is a misfire.
    expect(() =>
      SessionVariable.resolveToolArguments(
        "write",
        { filePath: "/w/{{var:missing}}.md", content: "ok" },
        () => undefined,
      ),
    ).toThrow(SessionVariable.MissingTemplateVariableError)
  })

  test("resolveToolArguments: edit old/new are lenient; a non-content tool stays strict-everywhere", () => {
    const { args, unresolved } = SessionVariable.resolveToolArguments(
      "edit",
      { path: "/w/RECON.md", old: "see {{var:name}}", new: "see {{var:name}} (documented)" },
      () => undefined,
    )
    expect(args.old).toBe("see {{var:name}}")
    expect(args.new).toBe("see {{var:name}} (documented)")
    expect(unresolved).toEqual(["name"])
    // webfetch has no content fields: a missing var throws exactly as the strict path always did.
    expect(() =>
      SessionVariable.resolveToolArguments("webfetch", { url: "https://x/{{var:missing}}" }, () => undefined),
    ).toThrow(SessionVariable.MissingTemplateVariableError)
  })

  test("resolveToolArguments: handoff summary is narrative, while the artifact stays strict", () => {
    const store: Record<string, SessionVariable.Value> = { confirmed_count: 4 }
    const { args, unresolved } = SessionVariable.resolveToolArguments(
      "handoff",
      {
        summary: "Confirmed {{var:confirmed_count}} findings; literal example {{var:name}}.",
        artifact: "work/run/RECON.md",
      },
      (name) => store[name],
    )
    expect(args.summary).toBe("Confirmed 4 findings; literal example {{var:name}}.")
    expect(args.artifact).toBe("work/run/RECON.md")
    expect(unresolved).toEqual(["name"])

    expect(() =>
      SessionVariable.resolveToolArguments(
        "handoff",
        { summary: "ready", artifact: "{{var:missing_path}}" },
        () => undefined,
      ),
    ).toThrow(SessionVariable.MissingTemplateVariableError)
  })
})
