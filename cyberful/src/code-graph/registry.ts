// ── Polyglot Language Registry ──────────────────────────────────────────────
// Owns deterministic language detection and the built-in application, systems,
// crypto, smart-contract, robotics, firmware, hardware, infrastructure, and
// data profiles. All built-ins use embedded source and perform no runtime
// downloads; stronger compiler or grammar adapters can be injected explicitly.
// ─────────────────────────────────────────────────────────────────────────────

import { createSemanticLanguageAdapter, type SemanticLanguageProfile } from "./semantic-adapter"
import { createHash } from "node:crypto"
import type { LanguageAdapter } from "./types"

export interface LanguageDetection {
  readonly adapter: LanguageAdapter
  readonly score: number
  readonly alternatives: readonly { readonly id: string; readonly score: number }[]
}

const application = ["application"] as const
const systems = ["systems"] as const
const crypto = ["crypto"] as const
const smartContract = ["smart-contract", "crypto"] as const
const roboticsSystems = ["robotics", "systems"] as const
const firmwareSystems = ["firmware", "systems"] as const
const hardware = ["hardware", "firmware"] as const
const infrastructure = ["infrastructure"] as const
const data = ["data"] as const

const profiles = [
  { id: "typescript", displayName: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"], domains: application },
  { id: "javascript", displayName: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"], domains: application },
  {
    id: "python",
    displayName: "Python",
    extensions: [".py", ".pyi"],
    domains: application,
    indentationScoped: true,
    hints: [/^#!.*python/m],
  },
  { id: "java", displayName: "Java", extensions: [".java"], domains: application },
  { id: "kotlin", displayName: "Kotlin", extensions: [".kt", ".kts"], domains: application },
  { id: "scala", displayName: "Scala", extensions: [".scala", ".sc"], domains: application },
  { id: "csharp", displayName: "C#", extensions: [".cs"], domains: application },
  { id: "fsharp", displayName: "F#", extensions: [".fs", ".fsi", ".fsx"], domains: application },
  { id: "go", displayName: "Go", extensions: [".go"], domains: application },
  { id: "swift", displayName: "Swift", extensions: [".swift"], domains: application },
  { id: "php", displayName: "PHP", extensions: [".php", ".phtml"], domains: application, hints: [/<\?php/] },
  {
    id: "ruby",
    displayName: "Ruby",
    extensions: [".rb", ".rake", ".gemspec"],
    filenames: ["Rakefile", "Gemfile"],
    domains: application,
    indentationScoped: true,
    hints: [/^#!.*ruby/m],
  },
  { id: "lua", displayName: "Lua", extensions: [".lua"], domains: application },
  { id: "erlang", displayName: "Erlang", extensions: [".erl", ".hrl"], domains: application },
  { id: "elixir", displayName: "Elixir", extensions: [".ex", ".exs"], domains: application },
  {
    id: "bash",
    displayName: "Bash/Shell",
    extensions: [".sh", ".bash", ".zsh", ".fish"],
    domains: application,
    hints: [/^#!.*(?:ba|z|fi)?sh/m],
  },
  { id: "sql", displayName: "SQL/Procedural SQL", extensions: [".sql", ".psql", ".plsql"], domains: data },

  { id: "c", displayName: "C", extensions: [".c", ".h"], domains: firmwareSystems },
  {
    id: "cpp",
    displayName: "C++",
    extensions: [".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".ino"],
    domains: roboticsSystems,
    hints: [/#include\s*<(?:iostream|vector|string|memory)>|\bnamespace\s+\w+|\btemplate\s*</],
  },
  {
    id: "objective-c",
    displayName: "Objective-C",
    extensions: [".m", ".mm"],
    domains: systems,
    hints: [/@(?:interface|implementation|protocol)|#import/],
  },
  { id: "rust", displayName: "Rust", extensions: [".rs"], domains: ["systems", "crypto", "firmware"] },
  { id: "zig", displayName: "Zig", extensions: [".zig"], domains: firmwareSystems },
  { id: "ada", displayName: "Ada/SPARK", extensions: [".adb", ".ads", ".ada"], domains: firmwareSystems },
  {
    id: "cuda",
    displayName: "CUDA",
    extensions: [".cu", ".cuh"],
    domains: systems,
    hints: [/__global__|__device__|cudaMalloc/],
  },
  {
    id: "wat",
    displayName: "WebAssembly Text",
    extensions: [".wat", ".wast"],
    domains: systems,
    hints: [/\(module\b/],
  },
  {
    id: "assembly",
    displayName: "Assembly",
    extensions: [".asm", ".s", ".S"],
    domains: firmwareSystems,
    hints: [/\b(?:mov|ldr|str|jal|call|ret)\b/i],
  },

  {
    id: "solidity",
    displayName: "Solidity",
    extensions: [".sol"],
    domains: smartContract,
    hints: [/pragma\s+solidity|\bcontract\s+\w+/],
  },
  {
    id: "vyper",
    displayName: "Vyper",
    extensions: [".vy", ".vyi"],
    domains: smartContract,
    indentationScoped: true,
    hints: [/@(?:external|internal|view|payable)/],
  },
  {
    id: "move",
    displayName: "Move",
    extensions: [".move"],
    domains: smartContract,
    hints: [/\bmodule\s+(?:0x)?[\w:]+/],
  },
  { id: "cairo", displayName: "Cairo", extensions: [".cairo"], domains: smartContract },
  {
    id: "circom",
    displayName: "Circom",
    extensions: [".circom"],
    domains: crypto,
    hints: [/pragma\s+circom|\btemplate\s+\w+/],
  },
  { id: "noir", displayName: "Noir", extensions: [".nr"], domains: crypto },
  { id: "sway", displayName: "Sway", extensions: [".sw"], domains: smartContract },
  { id: "clarity", displayName: "Clarity", extensions: [".clar"], domains: smartContract },
  { id: "haskell", displayName: "Haskell", extensions: [".hs", ".lhs"], domains: ["application", "crypto"] },

  {
    id: "matlab",
    displayName: "MATLAB",
    extensions: [".m"],
    domains: ["robotics", "data"],
    hints: [/^\s*function\b|^\s*%/m],
  },
  {
    id: "structured-text",
    displayName: "IEC 61131-3 Structured Text",
    extensions: [".st", ".iecst"],
    domains: ["robotics", "firmware"],
    hints: [/\b(?:PROGRAM|FUNCTION_BLOCK|VAR_INPUT)\b/i],
  },
  { id: "verilog", displayName: "Verilog", extensions: [".v", ".vh"], domains: hardware, hints: [/\bmodule\s+\w+/] },
  {
    id: "systemverilog",
    displayName: "SystemVerilog",
    extensions: [".sv", ".svh"],
    domains: hardware,
    hints: [/\b(?:interface|logic|always_ff|always_comb)\b/],
  },
  {
    id: "vhdl",
    displayName: "VHDL",
    extensions: [".vhd", ".vhdl"],
    domains: hardware,
    hints: [/\bentity\s+\w+\s+is\b/i],
  },

  {
    id: "protobuf",
    displayName: "Protocol Buffers",
    extensions: [".proto"],
    domains: ["infrastructure", "data"],
    declarative: true,
  },
  {
    id: "openapi",
    displayName: "OpenAPI",
    extensions: [".yaml", ".yml", ".json"],
    filenames: ["openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.yml", "swagger.json"],
    domains: ["application", "infrastructure"],
    declarative: true,
    hints: [/\bopenapi\s*:\s*["']?3\.|\bswagger\s*:\s*["']?2\./],
  },
  {
    id: "ros",
    displayName: "ROS/DDS Topology",
    extensions: [".launch", ".msg", ".srv", ".action"],
    filenames: ["package.xml"],
    domains: ["robotics", "infrastructure"],
    declarative: true,
    hints: [/<launch\b|<package\b|\bros__parameters\b/],
  },
  {
    id: "robot-model",
    displayName: "URDF/SDF/Xacro",
    extensions: [".urdf", ".sdf", ".xacro"],
    domains: ["robotics", "infrastructure"],
    declarative: true,
  },
  {
    id: "terraform",
    displayName: "Terraform/HCL",
    extensions: [".tf", ".tfvars", ".hcl"],
    domains: infrastructure,
    declarative: true,
  },
  {
    id: "kubernetes",
    displayName: "Kubernetes",
    extensions: [".yaml", ".yml"],
    domains: infrastructure,
    declarative: true,
    hints: [/^\s*apiVersion\s*:.*\n\s*kind\s*:/m],
  },
  { id: "yaml", displayName: "YAML", extensions: [".yaml", ".yml"], domains: infrastructure, declarative: true },
  {
    id: "json",
    displayName: "JSON",
    extensions: [".json", ".jsonc"],
    domains: ["infrastructure", "data"],
    declarative: true,
  },
  { id: "toml", displayName: "TOML", extensions: [".toml"], domains: infrastructure, declarative: true },
  { id: "xml", displayName: "XML", extensions: [".xml"], domains: infrastructure, declarative: true },
  {
    id: "dockerfile",
    displayName: "Dockerfile",
    extensions: [".dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
    domains: infrastructure,
    declarative: true,
  },
  {
    id: "cmake",
    displayName: "CMake",
    extensions: [".cmake"],
    filenames: ["CMakeLists.txt"],
    domains: infrastructure,
    declarative: true,
  },
  {
    id: "make",
    displayName: "Make",
    extensions: [".mk", ".mak"],
    filenames: ["Makefile", "GNUmakefile"],
    domains: infrastructure,
    declarative: true,
  },
  {
    id: "meson",
    displayName: "Meson",
    filenames: ["meson.build", "meson_options.txt"],
    domains: infrastructure,
    declarative: true,
  },
  {
    id: "bazel",
    displayName: "Bazel/Starlark",
    extensions: [".bzl"],
    filenames: ["BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"],
    domains: infrastructure,
    declarative: true,
  },
  {
    id: "linker-script",
    displayName: "Linker Script",
    extensions: [".ld", ".lds"],
    domains: firmwareSystems,
    declarative: true,
  },
  {
    id: "device-tree",
    displayName: "Device Tree",
    extensions: [".dts", ".dtsi", ".dtso"],
    domains: ["firmware", "hardware"],
    declarative: true,
  },
  {
    id: "project-manifest",
    displayName: "Project Manifest/Lockfile",
    filenames: [
      "package.json",
      "package-lock.json",
      "bun.lock",
      "bun.lockb",
      "yarn.lock",
      "pnpm-lock.yaml",
      "Cargo.toml",
      "Cargo.lock",
      "go.mod",
      "go.sum",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "requirements.txt",
      "Pipfile",
      "Pipfile.lock",
      "poetry.lock",
      "composer.json",
      "composer.lock",
      "Gemfile.lock",
      "Package.swift",
      "Podfile",
      "mix.exs",
      "rebar.config",
    ],
    domains: infrastructure,
    declarative: true,
  },
] satisfies readonly SemanticLanguageProfile[]

function validateAdapter(adapter: LanguageAdapter) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id)) throw new Error(`Invalid language adapter id: ${adapter.id}`)
  if (!adapter.displayName.trim()) throw new Error(`Language adapter ${adapter.id} has no display name.`)
  if (!adapter.version.trim()) throw new Error(`Language adapter ${adapter.id} has no version.`)
  if (!adapter.implementation || !adapter.implementation.version.trim())
    throw new Error(`Language adapter ${adapter.id} has no implementation version.`)
  if (!/^[a-f0-9]{64}$/.test(adapter.implementation.digest))
    throw new Error(`Language adapter ${adapter.id} has an invalid implementation digest.`)
}

// ── Detection Preserves Ambiguity Evidence ─────────────────────────────────
// Extensions such as .m, .h, YAML, and JSON are inherently ambiguous. The
// registry ranks exact filenames, extensions, and bounded content hints, then
// returns every positive alternative beside the winner. This keeps detection
// deterministic while allowing coverage reports and callers to surface a
// potentially ambiguous classification instead of silently hiding it.
// ─────────────────────────────────────────────────────────────────────────────

export class LanguageRegistry {
  readonly #adapters: readonly LanguageAdapter[]

  constructor(adapters: readonly LanguageAdapter[]) {
    const ids = new Set<string>()
    adapters.forEach((adapter) => {
      validateAdapter(adapter)
      if (ids.has(adapter.id)) throw new Error(`Duplicate language adapter id: ${adapter.id}`)
      ids.add(adapter.id)
    })
    this.#adapters = [...adapters]
  }

  list() {
    return this.#adapters
  }

  byId(id: string) {
    return this.#adapters.find((adapter) => adapter.id === id)
  }

  detect(input: { readonly path: string; readonly contentPrefix?: string }): LanguageDetection | undefined {
    const candidates = this.#adapters
      .map((adapter) => ({
        adapter,
        score: adapter.supports({ path: input.path, contentPrefix: input.contentPrefix ?? "" }),
      }))
      .filter((candidate) => candidate.score > 0)
      .toSorted((left, right) => right.score - left.score || left.adapter.id.localeCompare(right.adapter.id))
    const winner = candidates[0]
    if (!winner) return
    return {
      adapter: winner.adapter,
      score: winner.score,
      alternatives: candidates.slice(1).map((candidate) => ({ id: candidate.adapter.id, score: candidate.score })),
    }
  }
}

export function createDefaultLanguageRegistry() {
  return new LanguageRegistry(profiles.map(createSemanticLanguageAdapter))
}

export function adapterAnalysisFingerprint(adapter: LanguageAdapter) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: adapter.id,
        version: adapter.version,
        implementation: adapter.implementation,
      }),
    )
    .digest("hex")
}

function profileDigest(adapter: LanguageAdapter) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: adapter.id,
        version: adapter.version,
        implementation: adapter.implementation,
        domains: adapter.domains,
        extensions: adapter.extensions,
        filenames: adapter.filenames,
        declarative: adapter.declarative,
        capabilities: adapter.capabilities,
      }),
    )
    .digest("hex")
}

export function languageManifestFor(registry: LanguageRegistry) {
  return {
    schemaVersion: "1.0" as const,
    backend: {
      kind: "embedded-semantic-lexer" as const,
      runtimeDownload: false as const,
      grammarWasm: false as const,
      detail: "Repository-owned deterministic lexer profiles; no grammar artifact is claimed or fetched.",
    },
    languages: registry.list().map((adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      version: adapter.version,
      implementation: adapter.implementation,
      provenance: {
        source: "cyberful/src/code-graph/semantic-adapter.ts",
        license: "MIT" as const,
        integrity: { algorithm: "sha256" as const, value: profileDigest(adapter) },
      },
      domains: adapter.domains,
      extensions: adapter.extensions,
      filenames: adapter.filenames,
      declarative: adapter.declarative,
      capabilities: adapter.capabilities,
    })),
  }
}

export const builtInLanguageManifest = languageManifestFor(createDefaultLanguageRegistry())
