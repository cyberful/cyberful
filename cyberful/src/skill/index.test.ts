// ── Skill Discovery Experience Tests ─────────────────────────────
// Protects real skill metadata, compatibility layouts, invalid-input handling,
// and deterministic duplicate precedence exposed to users and agents.
// → cyberful/src/skill/index.ts — owns parsing and registry semantics under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CYBERFUL_SKILL_PATTERNS, Info, fmt, infoFromMarkdown } from "./index"

describe("Skill.fmt", () => {
  test("omits the skills block when no described skills are available", () => {
    expect(fmt([], { verbose: true })).toBeUndefined()
    expect(
      fmt(
        [
          {
            name: "hidden-skill",
            location: "/tmp/hidden-skill/SKILL.md",
            content: "Skill body",
          },
        ],
        { verbose: true },
      ),
    ).toBeUndefined()
  })
})

describe("Skill metadata", () => {
  test("accepts keyword lists for flat markdown skills", () => {
    const info = infoFromMarkdown({
      data: {
        name: "PATH_TRAVERSAL",
        description: "Use for path traversal testing.",
        keywords: ["path traversal", "../"],
      },
      location: "/repo/config/skills/PATH_TRAVERSAL.md",
      content: "Test canonicalization safely.",
    })

    expect(Schema.is(Info)(info)).toBe(true)
    expect(info?.keywords).toEqual(["path traversal", "../"])
  })

  test("keeps legacy SKILL.md skills working without keywords", () => {
    const info = infoFromMarkdown({
      data: {
        name: "web-pentest",
        description: "Use for broad web testing.",
      },
      location: "/repo/config/skills/web-pentest/SKILL.md",
      content: "Legacy skill body.",
    })

    expect(info?.name).toBe("web-pentest")
    expect(info?.keywords).toBeUndefined()
    expect(Schema.is(Info)(info)).toBe(true)
  })

  test("ignores invalid keyword metadata", () => {
    expect(
      infoFromMarkdown({
        data: {
          name: "invalid-keywords",
          description: "Invalid keyword shape.",
          keywords: "sql",
        },
        location: "/repo/config/skills/invalid-keywords.md",
        content: "Invalid skill body.",
      }),
    ).toBeUndefined()

    expect(
      infoFromMarkdown({
        data: {
          name: "invalid-keywords",
          description: "Invalid keyword entry.",
          keywords: ["sql", 123],
        },
        location: "/repo/config/skills/invalid-keywords.md",
        content: "Invalid skill body.",
      }),
    ).toBeUndefined()
  })

  test("duplicate names resolve to the later discovered skill", () => {
    const first = infoFromMarkdown({
      data: { name: "DUPLICATE", description: "First copy.", keywords: ["first"] },
      location: "/repo/config/skills/DUPLICATE.md",
      content: "First body.",
    })
    const second = infoFromMarkdown({
      data: { name: "DUPLICATE", description: "Second copy.", keywords: ["second"] },
      location: "/repo/config/skills/duplicate/SKILL.md",
      content: "Second body.",
    })
    const byName = new Map([first, second].flatMap((skill) => (skill ? [[skill.name, skill] as const] : [])))

    expect(byName.get("DUPLICATE")?.location).toBe("/repo/config/skills/duplicate/SKILL.md")
    expect(byName.get("DUPLICATE")?.keywords).toEqual(["second"])
  })

  test("flat cyberful skill files are in discovery patterns", () => {
    expect(CYBERFUL_SKILL_PATTERNS).toContain("{skill,skills}/*.md")
    expect(CYBERFUL_SKILL_PATTERNS).toContain("{skill,skills}/**/SKILL.md")
  })
})
