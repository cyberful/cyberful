// ── Polyglot Registry Conformance Tests ─────────────────────────────────────
// Verifies that every promised language family is represented by one embedded
// adapter, that every adapter executes the shared semantic contract, and that
// the published provenance digest can be independently recomputed. These tests
// prevent the manifest from advertising absent WASM or unsupported capability.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { builtInLanguageManifest, createDefaultLanguageRegistry } from "./registry"

const expectedLanguages = [
  "ada",
  "assembly",
  "bash",
  "bazel",
  "c",
  "cairo",
  "circom",
  "clarity",
  "cmake",
  "cpp",
  "csharp",
  "cuda",
  "device-tree",
  "dockerfile",
  "elixir",
  "erlang",
  "fsharp",
  "go",
  "haskell",
  "java",
  "javascript",
  "json",
  "kotlin",
  "kubernetes",
  "linker-script",
  "lua",
  "make",
  "matlab",
  "meson",
  "move",
  "noir",
  "objective-c",
  "openapi",
  "php",
  "project-manifest",
  "protobuf",
  "python",
  "robot-model",
  "ros",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "sql",
  "structured-text",
  "sway",
  "swift",
  "systemverilog",
  "terraform",
  "toml",
  "typescript",
  "verilog",
  "vhdl",
  "vyper",
  "wat",
  "xml",
  "yaml",
  "zig",
] as const

function digest(language: (typeof builtInLanguageManifest.languages)[number]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: language.id,
        version: language.version,
        implementation: language.implementation,
        domains: language.domains,
        extensions: language.extensions,
        filenames: language.filenames,
        declarative: language.declarative,
        capabilities: language.capabilities,
      }),
    )
    .digest("hex")
}

describe("embedded language manifest", () => {
  test("names every planned language and domain without claiming a WASM grammar", () => {
    expect(builtInLanguageManifest.backend).toEqual({
      kind: "embedded-semantic-lexer",
      runtimeDownload: false,
      grammarWasm: false,
      detail: "Repository-owned deterministic lexer profiles; no grammar artifact is claimed or fetched.",
    })
    expect(builtInLanguageManifest.languages.map((language) => language.id).toSorted()).toEqual([...expectedLanguages])
    expect(new Set(builtInLanguageManifest.languages.flatMap((language) => language.domains))).toEqual(
      new Set([
        "application",
        "systems",
        "crypto",
        "smart-contract",
        "robotics",
        "firmware",
        "hardware",
        "infrastructure",
        "data",
      ]),
    )
  })

  test("publishes reproducible MIT provenance and the effective capability matrix", () => {
    for (const language of builtInLanguageManifest.languages) {
      expect(language.provenance.source).toBe("cyberful/src/code-graph/semantic-adapter.ts")
      expect(language.provenance.license).toBe("MIT")
      expect(language.provenance.integrity.algorithm).toBe("sha256")
      expect(language.provenance.integrity.value).toBe(digest(language))
      expect(language.implementation.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(language.implementation.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(language.capabilities.parsing.level).toBe("exact")
      if (language.declarative) {
        expect(language.capabilities.controlFlow.level).toBe("unsupported")
        expect(language.capabilities.dataFlow.level).toBe("structural")
      } else {
        expect(language.capabilities.controlFlow.level).toBe("heuristic")
        expect(language.capabilities.dataFlow.level).toBe("heuristic")
        expect(language.capabilities.securitySemantics.level).toBe("heuristic")
      }
    }
  })
})

describe("language adapter conformance", () => {
  test("every adapter recognizes one owned path and returns bounded coverage evidence", () => {
    const registry = createDefaultLanguageRegistry()
    for (const adapter of registry.list()) {
      const ownedPath = adapter.filenames[0] ?? `fixture${adapter.extensions[0]}`
      expect(adapter.supports({ path: ownedPath, contentPrefix: "" })).toBeGreaterThan(0)
      const content = adapter.declarative
        ? 'resource "service" "api" {\n  secret = request.input\n  target = exec(secret)\n}\n'
        : "function auditTarget(input) {\n  const tainted = request.input\n  validate(tainted)\n  exec(tainted)\n}\n"
      const analysis = adapter.analyze({ path: ownedPath, content, contentHash: "a".repeat(64) })
      expect(analysis.nodes.length).toBeGreaterThanOrEqual(4)
      expect(analysis.nodes.some((node) => node.tags.includes("source"))).toBe(true)
      expect(analysis.nodes.some((node) => node.tags.includes("sink"))).toBe(true)
      expect(analysis.edges.some((edge) => edge.kind === "contains")).toBe(true)
      expect(analysis.coverage.capabilities).toEqual(adapter.capabilities)
      expect(analysis.coverage.limitations.length).toBeGreaterThan(0)
    }
  })

  test("family-specific constructs receive native security and topology tags", () => {
    const registry = createDefaultLanguageRegistry()
    const cases = [
      {
        id: "c",
        path: "driver.c",
        content: "int run(char *request) {\n memcpy(buffer, request, size);\n}\n",
        tags: ["source", "sink", "memory-unsafe"],
      },
      {
        id: "solidity",
        path: "Vault.sol",
        content: "contract Vault {\n function pay() public {\n delegatecall(msg.data);\n }\n}\n",
        tags: ["source", "sink", "external-call"],
      },
      {
        id: "rust",
        path: "crypto.rs",
        content: "pub fn sign(secret: Key) {\n let nonce = random();\n signature(nonce, secret);\n}\n",
        tags: ["secret", "crypto"],
      },
      {
        id: "structured-text",
        path: "cell.st",
        content: "FUNCTION_BLOCK Cell\n sensor := request.input;\n motor(sensor);\nEND_FUNCTION_BLOCK\n",
        tags: ["sensor", "actuator"],
      },
      {
        id: "verilog",
        path: "soc.v",
        content: "module soc;\n mmio_write(register, request);\nendmodule\n",
        tags: ["hardware-boundary", "sink"],
      },
    ] as const
    for (const item of cases) {
      const analysis = registry
        .byId(item.id)
        ?.analyze({ path: item.path, content: item.content, contentHash: "b".repeat(64) })
      expect(analysis).toBeDefined()
      const tags = new Set(analysis?.nodes.flatMap((node) => node.tags))
      item.tags.forEach((tag) => expect(tags.has(tag)).toBe(true))
    }
  })
})
