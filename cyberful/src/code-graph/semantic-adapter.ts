// ── Portable Semantic Language Adapter ──────────────────────────────────────
// Builds a conservative code-property graph from text without downloading a
// parser or invoking a project toolchain. Language profiles tune symbol and
// boundary recognition while one deterministic lexer supplies control, data,
// call, trust, crypto, native-memory, hardware, and robotics semantics.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import type {
  AdapterAnalysis,
  AdapterAnalyzeInput,
  AdapterEdge,
  AdapterNode,
  AdapterReference,
  GraphNodeKind,
  LanguageAdapter,
  LanguageCapabilities,
  LanguageDomain,
  SecurityTag,
} from "./types"

interface DefinitionPattern {
  readonly expression: RegExp
  readonly kind: GraphNodeKind
  readonly nameGroup?: number
}

export interface SemanticLanguageProfile {
  readonly id: string
  readonly displayName: string
  readonly version?: string
  readonly extensions?: readonly string[]
  readonly filenames?: readonly string[]
  readonly domains: readonly LanguageDomain[]
  readonly definitions?: readonly DefinitionPattern[]
  readonly hints?: readonly RegExp[]
  readonly declarative?: boolean
  readonly indentationScoped?: boolean
  readonly limitations?: readonly string[]
}

const exactLexing = { level: "exact", detail: "Deterministic bounded lexical scan." } as const
const heuristicSymbols = {
  level: "heuristic",
  detail: "Language-profiled declarations with stable locations.",
} as const
const heuristicControl = {
  level: "heuristic",
  detail: "Intra-scope sequencing and branch boundary recognition.",
} as const
const heuristicCalls = {
  level: "heuristic",
  detail: "Call references are resolved against the persistent symbol index.",
} as const
const heuristicData = { level: "heuristic", detail: "Lexical def-use chains with assignment propagation." } as const
const heuristicAliasing = {
  level: "heuristic",
  detail: "Direct assignments and common reference/pointer forms.",
} as const
const heuristicSummaries = {
  level: "heuristic",
  detail: "Fixed-point summaries over calls and tagged operations.",
} as const
const heuristicSecurity = {
  level: "heuristic",
  detail: "Domain-aware source, sink, guard, crypto, and boundary tags.",
} as const
const heuristicCrossLanguage = {
  level: "heuristic",
  detail: "FFI, ABI, import, schema, topic, and generated-binding references.",
} as const

export const semanticCapabilities: LanguageCapabilities = {
  parsing: exactLexing,
  symbols: heuristicSymbols,
  controlFlow: heuristicControl,
  callGraph: heuristicCalls,
  dataFlow: heuristicData,
  aliasing: heuristicAliasing,
  summaries: heuristicSummaries,
  securitySemantics: heuristicSecurity,
  crossLanguage: heuristicCrossLanguage,
}

const declarativeCapabilities: LanguageCapabilities = {
  parsing: exactLexing,
  symbols: { level: "structural", detail: "Resources, keys, sections, and topology objects." },
  controlFlow: { level: "unsupported", detail: "Declarative artifacts do not define an execution CFG." },
  callGraph: { level: "unsupported", detail: "Dependency and configuration edges replace calls." },
  dataFlow: { level: "structural", detail: "Value references and resource wiring only." },
  aliasing: { level: "unsupported", detail: "No runtime alias model applies." },
  summaries: { level: "structural", detail: "Topology and trust-boundary summaries." },
  securitySemantics: heuristicSecurity,
  crossLanguage: heuristicCrossLanguage,
}

const SEMANTIC_ADAPTER_IMPLEMENTATION_VERSION = "1.0.0"
const SEMANTIC_RULESET_VERSION = "1.0.0"

const commonDefinitions: readonly DefinitionPattern[] = [
  { expression: /^\s*(?:async\s+)?(?:export\s+)?(?:default\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  { expression: /^\s*(?:pub(?:lic)?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { expression: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
  {
    expression:
      /^\s*(?:public|private|protected|internal|static|final|virtual|override|abstract|synchronized|native|unsafe|extern|async|inline|constexpr|consteval|friend|template\s*<[^>]+>|[A-Za-z_]\w*(?:<[^>]+>)?)\s+(?:[A-Za-z_][\w:<>,.*&?\[\]\s]+\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|throws\b|$)/,
    kind: "method",
  },
  { expression: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$]\w*)/, kind: "class" },
  { expression: /^\s*(?:export\s+)?interface\s+([A-Za-z_$]\w*)/, kind: "interface" },
  {
    expression: /^\s*(?:contract|library|trait|struct|enum|namespace|module|package)\s+([A-Za-z_$][\w.:]*)/,
    kind: "module",
  },
  { expression: /^\s*(?:sub|function)\s+([A-Za-z_]\w*)/i, kind: "function" },
]

const domainDefinitions: readonly DefinitionPattern[] = [
  { expression: /^\s*(?:module|macromodule)\s+([A-Za-z_]\w*)/i, kind: "module" },
  { expression: /^\s*entity\s+([A-Za-z_]\w*)\s+is\b/i, kind: "module" },
  { expression: /^\s*(?:architecture|process)\s+([A-Za-z_]\w*)?/i, kind: "block", nameGroup: 1 },
  { expression: /^\s*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD)\s+([A-Za-z_]\w*)/i, kind: "function" },
  {
    expression: /^\s*(?:resource|data|module|provider|variable|output)\s+"([^"]+)"(?:\s+"([^"]+)")?/,
    kind: "resource",
  },
  { expression: /^\s*([A-Za-z_.$][\w.$@-]*):(?:\s|$)/, kind: "block" },
  { expression: /^\s*(?:CREATE\s+)?(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TRIGGER)\s+([\w.$]+)/i, kind: "function" },
]

const keywords = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "typeof",
  "alignof",
  "defined",
  "match",
  "loop",
  "function",
  "def",
  "fn",
  "func",
  "class",
  "interface",
  "new",
  "delete",
  "assert",
  "require",
  "include",
  "import",
  "from",
  "using",
  "use",
  "module",
  "process",
  "begin",
  "end",
])

const securityPatterns: readonly { readonly tag: SecurityTag; readonly expression: RegExp }[] = [
  {
    tag: "source",
    expression:
      /\b(?:request|req\.(?:body|query|params|headers)|input|argv|argc|stdin|scanf|gets|getenv|recv|readline|read_line|deserialize|unmarshal|load[s]?\b|sensor|subscription|subscriber|msg\b|calldata|msg\.(?:data|sender|value))\b/i,
  },
  {
    tag: "sink",
    expression:
      /\b(?:eval|exec|system|popen|spawn|query|execute|rawQuery|innerHTML|document\.write|open|writeFile|send|publish|printf|sprintf|strcpy|strcat|memcpy|memmove|delegatecall|selfdestruct|callcode|actuat\w*|motor|gpio_write|mmio_write)\b/i,
  },
  {
    tag: "guard",
    expression:
      /\b(?:authorize|authenticated|permission|validate|verify|check|bounds|assert|require|ensure|is_valid|allowed|policy|acl|role)\w*\b/i,
  },
  {
    tag: "sanitizer",
    expression:
      /\b(?:sanitize|escape|encode|parameterize|prepare|quote|clean|normalize|canonicalize|purify|constant_time)\w*\b/i,
  },
  {
    tag: "secret",
    expression: /\b(?:private[_-]?key|secret|password|passwd|token|api[_-]?key|mnemonic|seed|credential)\b/i,
  },
  {
    tag: "crypto",
    expression:
      /\b(?:encrypt|decrypt|cipher|hash|sha\d*|md5|nonce|signature|sign|verify|ecdsa|ed25519|rsa|aes|chacha|random|rng|keypair|zeroize)\w*\b/i,
  },
  {
    tag: "memory-unsafe",
    expression:
      /\b(?:unsafe|malloc|calloc|realloc|free|memcpy|memmove|strcpy|strcat|sprintf|alloca|reinterpret_cast|transmute|raw[_ ]pointer)\b/i,
  },
  {
    tag: "external-call",
    expression:
      /\b(?:delegatecall|staticcall|callcode|external_call|http|fetch|request|socket|publish|send|ffi|pinvoke|jni|wasm_import)\b/i,
  },
  {
    tag: "privileged",
    expression:
      /\b(?:root|admin|sudo|setuid|capability|privileged|owner|governance|upgrade|firmware_update|bootloader)\b/i,
  },
  {
    tag: "sensor",
    expression: /\b(?:sensor|camera|lidar|radar|imu|odometry|telemetry|subscriber|subscription|adc_read)\b/i,
  },
  {
    tag: "actuator",
    expression:
      /\b(?:actuator|motor|servo|thruster|gpio_write|dac_write|publisher|publish|trajectory|velocity_cmd|cmd_vel)\b/i,
  },
  {
    tag: "hardware-boundary",
    expression:
      /\b(?:mmio|dma|register|interrupt|irq|device_tree|secure_boot|jtag|swd|uart|spi|i2c|can_bus|fieldbus|modbus)\b/i,
  },
]

const importPatterns: readonly { readonly expression: RegExp; readonly kind: AdapterReference["kind"] }[] = [
  { expression: /^\s*(?:import|from|require|include|using|use|with)\s*[('"<]*([@A-Za-z0-9_./:+-]+)/i, kind: "import" },
  { expression: /^\s*#\s*include\s*[<"]([^>"]+)/, kind: "import" },
  { expression: /\b(?:DllImport|LibraryImport)\s*\(\s*"([^"]+)"/i, kind: "ffi" },
  { expression: /\b(?:dlopen|LoadLibrary|System\.loadLibrary|ctypes\.CDLL|ffi_lib)\s*\(\s*["']([^"']+)/, kind: "ffi" },
  { expression: /\b(?:extern\s+"C"|JNIEXPORT|wasm_import|link_name)\b[^A-Za-z_]*([A-Za-z_]\w*)?/i, kind: "ffi" },
  { expression: /\b(?:topic|subscribe|publisher|publish)\s*\(\s*["']([^"']+)/i, kind: "subscribes" },
  { expression: /\b(?:abi|contract|interface)\s*[:=(]\s*["']?([A-Za-z_]\w*)/i, kind: "abi" },
  {
    expression: /\b(?:generated|codegen|protobuf|openapi|bindgen)\b[^A-Za-z0-9_./-]+([A-Za-z0-9_./-]+)/i,
    kind: "generated",
  },
]

interface Scope {
  readonly key: string
  readonly indent: number
  readonly braceDepth: number
}

function indentation(line: string) {
  const prefix = /^\s*/.exec(line)?.[0] ?? ""
  return prefix.replaceAll("\t", "    ").length
}

function braceDelta(line: string) {
  let delta = 0
  let quote: "'" | '"' | "`" | undefined
  let escaped = false
  for (const character of line) {
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (character === "{") delta += 1
    if (character === "}") delta -= 1
  }
  return delta
}

function tagsFor(line: string) {
  return securityPatterns.filter((pattern) => pattern.expression.test(line)).map((pattern) => pattern.tag)
}

function definitionFor(line: string, definitions: readonly DefinitionPattern[]) {
  for (const pattern of definitions) {
    const match = pattern.expression.exec(line)
    if (!match) continue
    const name = match[pattern.nameGroup ?? 1]?.trim() || `${pattern.kind}@anonymous`
    return { kind: pattern.kind, name, column: Math.max(1, match.index + 1) }
  }
}

function identifiers(line: string) {
  const result = new Set<string>()
  for (const match of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const identifier = match[0]
    if (!keywords.has(identifier.toLowerCase())) result.add(identifier)
  }
  return [...result]
}

function assignedIdentifiers(line: string) {
  const result = new Set<string>()
  for (const match of line.matchAll(
    /(?:^|[,;(]\s*|\b(?:let|const|var|auto|mut|val|local|signal|variable)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=(?!=)/g,
  )) {
    const name = match[1]
    if (name) result.add(name)
  }
  return result
}

function callNames(line: string) {
  const names = new Set<string>()
  for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*(?:(?:::|\.|->)[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const full = match[1]
    if (!full) continue
    const name = full.split(/::|\.|->/).at(-1)
    if (name && !keywords.has(name.toLowerCase())) names.add(name)
  }
  return [...names]
}

function referenceFor(line: string, from: string, lineNumber: number) {
  return importPatterns.flatMap((pattern): AdapterReference[] => {
    const match = pattern.expression.exec(line)
    const targetName = match?.[1]?.trim()
    if (!targetName) return []
    return [{ from, targetName, kind: pattern.kind, line: lineNumber, evidence: line.trim().slice(0, 240) }]
  })
}

function deduplicateEdges(edges: readonly AdapterEdge[]) {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.source}\0${edge.target}\0${edge.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function regularExpressionIdentity(expression: RegExp) {
  return { source: expression.source, flags: expression.flags }
}

function semanticImplementationDigest(profile: SemanticLanguageProfile, capabilities: LanguageCapabilities) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementationVersion: SEMANTIC_ADAPTER_IMPLEMENTATION_VERSION,
        rulesetVersion: profile.version ?? SEMANTIC_RULESET_VERSION,
        profile: {
          id: profile.id,
          extensions: profile.extensions ?? [],
          filenames: profile.filenames ?? [],
          domains: profile.domains,
          definitions: (profile.definitions ?? []).map((definition) => ({
            expression: regularExpressionIdentity(definition.expression),
            kind: definition.kind,
            nameGroup: definition.nameGroup,
          })),
          hints: (profile.hints ?? []).map(regularExpressionIdentity),
          declarative: profile.declarative ?? false,
          indentationScoped: profile.indentationScoped ?? false,
          limitations: profile.limitations ?? [],
        },
        commonDefinitions: commonDefinitions.map((definition) => ({
          expression: regularExpressionIdentity(definition.expression),
          kind: definition.kind,
          nameGroup: definition.nameGroup,
        })),
        domainDefinitions: domainDefinitions.map((definition) => ({
          expression: regularExpressionIdentity(definition.expression),
          kind: definition.kind,
          nameGroup: definition.nameGroup,
        })),
        keywords: [...keywords].toSorted(),
        securityPatterns: securityPatterns.map((pattern) => ({
          tag: pattern.tag,
          expression: regularExpressionIdentity(pattern.expression),
        })),
        importPatterns: importPatterns.map((pattern) => ({
          kind: pattern.kind,
          expression: regularExpressionIdentity(pattern.expression),
        })),
        capabilities,
      }),
    )
    .digest("hex")
}

// ── Coverage Is A Result, Not A Language Label ──────────────────────────────
// A portable lexer can operate uniformly across the requested ecosystem, but
// it cannot truthfully claim compiler-grade type or alias resolution. Every
// result therefore carries capability levels and concrete limitations. Domain
// profiles improve recognition while callers retain enough evidence to decide
// whether a compiler-backed verification pass is required.
// ─────────────────────────────────────────────────────────────────────────────

export function createSemanticLanguageAdapter(profile: SemanticLanguageProfile): LanguageAdapter {
  const extensions = (profile.extensions ?? []).map((extension) => extension.toLowerCase())
  const filenames = profile.filenames ?? []
  const capabilities = profile.declarative ? declarativeCapabilities : semanticCapabilities
  const definitions = [...(profile.definitions ?? []), ...commonDefinitions, ...domainDefinitions]

  return {
    id: profile.id,
    displayName: profile.displayName,
    version: profile.version ?? SEMANTIC_RULESET_VERSION,
    implementation: {
      version: SEMANTIC_ADAPTER_IMPLEMENTATION_VERSION,
      digest: semanticImplementationDigest(profile, capabilities),
    },
    domains: profile.domains,
    extensions,
    filenames,
    capabilities,
    declarative: profile.declarative ?? false,
    supports(input) {
      const normalizedPath = input.path.replaceAll("\\", "/")
      const basename = normalizedPath.split("/").at(-1) ?? normalizedPath
      const dot = basename.lastIndexOf(".")
      const extension = dot === -1 ? "" : basename.slice(dot).toLowerCase()
      const filenameScore = filenames.some((name) => name.toLowerCase() === basename.toLowerCase()) ? 100 : 0
      const extensionScore = extensions.includes(extension) ? 60 : 0
      const hintScore = (profile.hints ?? []).some((hint) => hint.test(input.contentPrefix)) ? 25 : 0
      return filenameScore + extensionScore + hintScore
    },
    analyze(input: AdapterAnalyzeInput): AdapterAnalysis {
      const lines = input.content.split(/\r?\n/)
      const nodes: AdapterNode[] = [
        {
          key: "file",
          kind: "file",
          name: input.path,
          line: 1,
          column: 1,
          endLine: Math.max(1, lines.length),
          tags: [],
          attributes: { contentHash: input.contentHash },
        },
      ]
      const edges: AdapterEdge[] = []
      const references: AdapterReference[] = []
      const diagnostics: string[] = []
      const scopes: Scope[] = [{ key: "file", indent: -1, braceDepth: -1 }]
      const lastStatementByScope = new Map<string, string>()
      const lastDefinitionByScope = new Map<string, Map<string, string>>()
      const lastGuardByScope = new Map<string, string>()
      let braceDepth = 0

      lines.forEach((rawLine, index) => {
        const lineNumber = index + 1
        const line = rawLine.length > 20_000 ? rawLine.slice(0, 20_000) : rawLine
        if (line.length !== rawLine.length)
          diagnostics.push(`Line ${lineNumber} exceeded 20000 characters and was truncated.`)
        const trimmed = line.trim()
        if (!trimmed || /^(?:\/\/|#(?!\s*include)|--|;)/.test(trimmed)) {
          braceDepth += braceDelta(line)
          return
        }

        const lineIndent = indentation(line)
        if (profile.indentationScoped) {
          while (scopes.length > 1 && lineIndent <= (scopes.at(-1)?.indent ?? -1)) scopes.pop()
        } else {
          while (scopes.length > 1 && braceDepth < (scopes.at(-1)?.braceDepth ?? -1)) scopes.pop()
        }

        const parent = scopes.at(-1)?.key ?? "file"
        const definition = definitionFor(line, definitions)
        const tags = tagsFor(line)
        const key = definition
          ? `symbol:${definition.kind}:${definition.name}:${lineNumber}`
          : `${profile.declarative ? "resource" : "statement"}:${lineNumber}`
        const kind = definition?.kind ?? (profile.declarative ? "resource" : "statement")
        nodes.push({
          key,
          kind,
          name: definition?.name ?? trimmed.slice(0, 160),
          line: lineNumber,
          column: definition?.column ?? lineIndent + 1,
          endLine: lineNumber,
          tags,
          attributes: { scope: parent },
        })
        edges.push({ source: parent, target: key, kind: "contains", weight: 0 })

        const previousStatement = lastStatementByScope.get(parent)
        if (previousStatement) edges.push({ source: previousStatement, target: key, kind: "control", weight: 1 })
        lastStatementByScope.set(parent, key)

        const definitionsInScope = lastDefinitionByScope.get(parent) ?? new Map<string, string>()
        const assignments = assignedIdentifiers(line)
        for (const identifier of identifiers(line)) {
          if (assignments.has(identifier)) continue
          const source = definitionsInScope.get(identifier)
          if (source) edges.push({ source, target: key, kind: "data", weight: 1, evidence: identifier })
        }
        assignments.forEach((identifier) => definitionsInScope.set(identifier, key))
        lastDefinitionByScope.set(parent, definitionsInScope)

        if (tags.includes("guard") || tags.includes("sanitizer")) lastGuardByScope.set(parent, key)
        if (tags.includes("source"))
          edges.push({ source: key, target: parent, kind: "data", weight: 1, evidence: "source-summary" })
        if (tags.includes("sink")) {
          edges.push({ source: parent, target: key, kind: "data", weight: 1, evidence: "sink-summary" })
          const guard = lastGuardByScope.get(parent)
          if (guard) edges.push({ source: key, target: guard, kind: "guarded-by", weight: 0.25 })
        }

        for (const name of callNames(line)) {
          references.push({
            from: key,
            targetName: name,
            kind: "call",
            line: lineNumber,
            evidence: trimmed.slice(0, 240),
          })
        }
        references.push(...referenceFor(line, key, lineNumber))

        if (tags.includes("source") && tags.includes("sink")) {
          edges.push({ source: key, target: key, kind: "trust-crossing", weight: 2, evidence: trimmed.slice(0, 240) })
        }
        if (tags.includes("sensor") && tags.includes("actuator")) {
          edges.push({ source: key, target: key, kind: "trust-crossing", weight: 2, evidence: "sensor-to-actuator" })
        }

        const delta = braceDelta(line)
        if (definition && (profile.indentationScoped || delta > 0 || /\b(?:begin|is|do)\b/i.test(trimmed))) {
          scopes.push({ key, indent: lineIndent, braceDepth: braceDepth + Math.max(1, delta) })
        }
        braceDepth += delta
      })

      return {
        nodes,
        edges: deduplicateEdges(edges),
        references,
        coverage: {
          parser: profile.declarative ? "declarative" : "semantic-lexer",
          confidence: profile.declarative ? 0.7 : 0.62,
          capabilities,
          limitations: [
            "Compiler-grade type resolution is not available in the portable adapter.",
            "Dynamic dispatch, macros, templates, reflection, and pointer aliasing may require verification.",
            ...(profile.limitations ?? []),
          ],
        },
        diagnostics,
      }
    },
  }
}
