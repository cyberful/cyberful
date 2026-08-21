#!/usr/bin/env bun
// ── Built-in Skill Package Validation ───────────────────────────
// Validates the exact first-party catalog, progressive metadata, UI adapters,
// framework mappings, package links, and active script manifests as one gate.
// → cyberful/builtin/skills/framework-sources.json — pins official framework snapshots.
// → cyberful/package.json — exposes this validator to CI and maintainers.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { lstat, readdir } from "node:fs/promises"
import type { AnySchema, ValidateFunction } from "ajv"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import matter from "gray-matter"

const skillRoot = path.resolve(import.meta.dir, "../builtin/skills")
const configuredDocumentationRoot = process.env.CYBERFUL_DOCUMENTATION_ROOT
const documentationRoot = path.resolve(
  configuredDocumentationRoot ?? path.join(import.meta.dir, "../../../cy-website/src/content/documentation"),
)
const intentPattern = /^(?:test|audit|trace|analyze|operate|assess|plan|report)-[a-z0-9]+(?:-[a-z0-9]+)*$/
const frameworkKeys = ["mitre_attack", "nist_csf", "mitre_atlas", "mitre_d3fend", "nist_ai_rmf", "mitre_f3", "pci_dss", "gdpr"] as const
const pinnedFrameworkKeys = ["nist_csf", "mitre_atlas", "mitre_d3fend", "nist_ai_rmf", "mitre_f3", "pci_dss", "gdpr"] as const
const workflows = new Set(["pentest", "bug-bounty", "code-audit"])
const phases = new Set(["brief", "recon", "exploit", "hacker", "verify", "report", "scope", "index", "trace", "hunt", "attack"])
const modelSelectedTransportFields = new Set([
  "proxy_url",
  "proxy_origin",
  "proxy",
  "gateway_url",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "ca_bundle",
  "ca_file",
  "cacert",
  "ssl_cert_file",
  "curl_ca_bundle",
  "tls_verify",
  "verify_tls",
  "insecure",
])
const runtimeTransportEnvironment = /(?:^|_)(?:PROXY|CA_BUNDLE|CA_FILE|SSL_CERT_FILE|SSL_CERT_DIR)$/

type FrameworkKey = (typeof frameworkKeys)[number]
type PinnedFrameworkKey = (typeof pinnedFrameworkKeys)[number]
type FrameworkSourceDigests = Readonly<Record<PinnedFrameworkKey, string>>
type FrameworkIdentifierIndex = Readonly<Record<FrameworkKey, ReadonlySet<string>>>

export const NEW_SKILL_NAMES = [
  "plan-authorized-ai-red-team",
  "assess-ai-system-risk",
  "audit-ai-model-supply-chain",
  "trace-ai-context-capabilities",
  "test-ai-prompt-injection",
  "test-ai-tool-authorization",
  "test-rag-isolation-integrity",
  "assess-identity-architecture",
  "audit-access-policy-enforcement",
  "trace-identity-propagation",
  "trace-tenant-context-propagation",
  "test-service-workload-identity",
  "test-account-recovery-assurance",
  "test-identity-linking-provisioning",
  "trace-request-normalization",
  "trace-file-processing-pipelines",
  "test-web-cache-behavior",
  "test-browser-messaging-boundaries",
  "test-deserialization-object-binding",
  "test-email-channel-security",
  "audit-api-contract-implementation",
  "analyze-api-contract-coverage",
  "test-grpc-protobuf-security",
  "test-soap-xml-services",
  "test-event-queue-boundaries",
  "trace-distributed-request-causality",
  "audit-infrastructure-as-code",
  "audit-build-release-pipelines",
  "audit-serverless-security",
  "audit-kubernetes-policy-enforcement",
  "audit-container-runtime-isolation",
  "audit-secrets-management",
  "trace-secret-propagation",
  "test-serverless-event-security",
  "analyze-cloud-control-plane-evidence",
  "assess-fraud-abuse-model",
  "analyze-fraud-control-evidence",
  "trace-transaction-state",
  "test-payment-fraud-controls",
  "test-promotion-entitlement-abuse",
  "test-automated-account-abuse",
  "assess-smart-contract-security",
  "assess-embedded-iot-security",
  "audit-smart-contract-security",
  "test-smart-contract-invariants",
  "audit-embedded-firmware-security",
  "audit-desktop-client-security",
  "audit-security-logging-telemetry",
  "audit-database-access-layer",
  "analyze-http-traffic-evidence",
  "analyze-network-packet-captures",
  "analyze-crash-exploitability",
  "analyze-scan-findings",
  "analyze-release-security-diff",
  "plan-pci-dss-penetration-test",
  "trace-cardholder-data-environment",
  "test-cardholder-data-segmentation",
  "audit-pci-dss-penetration-test-evidence",
  "assess-pci-dss-readiness",
  "report-of-compliance",
  "operate-mitre-attack",
] as const

const EXISTING_SKILL_NAMES = [
  "assess-application-threat-model",
  "assess-mobile-security",
  "audit-ai-agent-security",
  "audit-application-code",
  "audit-cloud-native-security",
  "audit-native-memory-safety",
  "audit-software-supply-chain",
  "operate-active-directory-toolchain",
  "operate-binary-analysis-toolchain",
  "operate-browser",
  "operate-cloud-posture-toolchain",
  "operate-code-graph",
  "operate-content-discovery",
  "operate-evm-security-toolchain",
  "operate-firefox-marionette",
  "operate-firmware-laboratory",
  "operate-kubernetes-toolchain",
  "operate-metasploit",
  "operate-mobile-instrumentation",
  "operate-native-debugging",
  "operate-native-fuzzing",
  "operate-network-recon",
  "operate-nuclei",
  "operate-sast-toolchain",
  "operate-sqlmap",
  "operate-supply-chain-toolchain",
  "operate-tls-toolchain",
  "operate-zap",
  "plan-authorized-pentest",
  "test-api-security",
  "test-authentication-lifecycle",
  "test-authorization-boundaries",
  "test-binary-protocols",
  "test-browser-security",
  "test-business-logic",
  "test-concurrency-resource-abuse",
  "test-data-protection-crypto",
  "test-exposed-services",
  "test-federated-identity",
  "test-file-parser-security",
  "test-graphql-security",
  "test-http-intermediaries",
  "test-realtime-integrations",
  "test-server-side-fetching",
  "test-session-security",
  "trace-injection-dataflows",
] as const

export const EXPECTED_SKILL_NAMES = [...EXISTING_SKILL_NAMES, ...NEW_SKILL_NAMES].toSorted()

type RecordValue = Readonly<Record<string, unknown>>

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as RecordValue
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function stringList(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))
    throw new Error(`${label} must be an array of non-empty strings`)
  const values = value.map((item) => item.trim())
  if (values.length < minimum || values.length > maximum)
    throw new Error(`${label} must contain between ${minimum} and ${maximum} entries`)
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`)
  return values
}

async function regularFile(filename: string, label: string): Promise<void> {
  const metadata = await lstat(filename).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
}

async function packageRegularFile(
  packageRoot: string,
  requestedPath: string,
  label: string,
  requiredDirectory?: string,
): Promise<string> {
  if (path.isAbsolute(requestedPath)) throw new Error(`${label} must use a package-relative path`)
  const components = requestedPath.split(/[\\/]+/)
  if (components.some((component) => !component || component === "." || component === ".."))
    throw new Error(`${label} must not contain empty, dot, or traversal components`)
  if (requiredDirectory && components[0] !== requiredDirectory)
    throw new Error(`${label} must remain below ${requiredDirectory}/`)
  const resolved = path.resolve(packageRoot, ...components)
  const relative = path.relative(packageRoot, resolved)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`${label} escapes the skill package`)
  let cursor = packageRoot
  for (const component of components) {
    cursor = path.join(cursor, component)
    const metadata = await lstat(cursor).catch(() => undefined)
    if (!metadata) throw new Error(`${label} does not exist`)
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`)
  }
  await regularFile(resolved, label)
  return resolved
}

function frameworkIdentifier(key: (typeof frameworkKeys)[number], value: string): boolean {
  switch (key) {
    case "mitre_attack":
      return /^T\d{4}(?:\.\d{3})?$/.test(value)
    case "nist_csf":
      return /^(?:GV|ID|PR|DE|RS|RC)\.[A-Z]{2}(?:-\d{2})?$/.test(value)
    case "mitre_atlas":
      return /^AML\.(?:TA|T|M)\d{4}(?:\.\d{3})?$/.test(value)
    case "mitre_d3fend":
      return /^D3-[A-Z0-9-]{2,}$/.test(value)
    case "nist_ai_rmf":
      return /^(?:GOVERN|MAP|MEASURE|MANAGE)(?:[ .-]\d+(?:\.\d+)?)?$/.test(value)
    case "mitre_f3":
      return /^F\d{4}(?:\.\d{3})?$/.test(value)
    case "pci_dss":
      return /^\d+(?:\.\d+){2,3}$/.test(value)
    case "gdpr":
      return /^Article (?:[1-9]|[1-9]\d)(?:\(\d+\))?$/.test(value)
  }
}

function nestedObjectKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(nestedObjectKeys)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...nestedObjectKeys(child)])
}

function compileSchema(schema: unknown, label: string): ValidateFunction {
  const validator = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false })
  addFormats(validator)
  try {
    return validator.compile(schema as AnySchema)
  } catch (error) {
    throw new Error(`${label} is not a valid draft 2020-12 JSON Schema: ${String(error)}`)
  }
}

async function validateLinks(packageRoot: string, sourceFile: string, source: string, label: string): Promise<void> {
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.trim()
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue
    const withoutAnchor = target.split("#", 1)[0]
    if (!withoutAnchor) continue
    const resolved = path.resolve(path.dirname(sourceFile), withoutAnchor)
    const relative = path.relative(packageRoot, resolved)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`${label} link escapes the skill package: ${target}`)
    const packageRelative = path.relative(packageRoot, resolved)
    await packageRegularFile(packageRoot, packageRelative, `${label} link '${target}'`)
  }
}

async function markdownReferences(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`reference tree must not contain symbolic links: ${filename}`)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(filename)
    }
  }
  await visit(root)
  return files.toSorted()
}

async function validateFrameworkSources(root = skillRoot): Promise<FrameworkSourceDigests> {
  const filename = path.join(root, "framework-sources.json")
  const source = record(JSON.parse(await Bun.file(filename).text()), "framework source manifest")
  if (source.schema_version !== 1 || source.update_policy !== "manual")
    throw new Error("framework source manifest must be schema version 1 with manual updates")
  const frameworks = record(source.frameworks, "framework source manifest frameworks")
  if (Object.keys(frameworks).toSorted().join("\0") !== [...pinnedFrameworkKeys].toSorted().join("\0"))
    throw new Error(`framework source manifest must define exactly the ${pinnedFrameworkKeys.length} statically pinned frameworks`)
  const digests = {} as Record<PinnedFrameworkKey, string>
  for (const key of pinnedFrameworkKeys) {
    const entry = record(frameworks[key], `framework source '${key}'`)
    stringValue(entry.name, `framework source '${key}' name`)
    stringValue(entry.version, `framework source '${key}' version`)
    const sourceURL = stringValue(entry.source, `framework source '${key}' URL`)
    if (!sourceURL.startsWith("https://")) throw new Error(`framework source '${key}' must use HTTPS`)
    const digest = stringValue(entry.sha256, `framework source '${key}' SHA-256`)
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new Error(`framework source '${key}' must contain a lowercase SHA-256 digest`)
    digests[key] = digest
  }
  return digests
}

async function validateFrameworkIdentifiers(
  root: string,
  sourceDigests: FrameworkSourceDigests,
): Promise<FrameworkIdentifierIndex> {
  const filename = path.join(root, "framework-identifiers.json")
  const source = record(JSON.parse(await Bun.file(filename).text()), "framework identifier manifest")
  if (source.schema_version !== 1) throw new Error("framework identifier manifest must be schema version 1")
  const frameworks = record(source.frameworks, "framework identifier manifest frameworks")
  if (Object.keys(frameworks).toSorted().join("\0") !== [...frameworkKeys].toSorted().join("\0"))
    throw new Error(`framework identifier manifest must define exactly the ${frameworkKeys.length} supported frameworks`)
  const index = {} as Record<FrameworkKey, ReadonlySet<string>>
  for (const key of frameworkKeys) {
    const entry = record(frameworks[key], `framework identifier '${key}'`)
    if (key === "mitre_attack") {
      if (entry.source_sha256 !== undefined)
        throw new Error("MITRE ATT&CK identifiers must be verified against the build snapshot instead of a static source digest")
    } else {
      const digest = stringValue(entry.source_sha256, `framework identifier '${key}' source SHA-256`)
      if (digest !== sourceDigests[key])
        throw new Error(`framework identifier '${key}' source SHA-256 does not match framework-sources.json`)
    }
    const identifiers = stringList(entry.identifiers, `framework identifier '${key}' values`, 1, 512)
    if (identifiers.join("\0") !== identifiers.toSorted().join("\0"))
      throw new Error(`framework identifier '${key}' values must be sorted deterministically`)
    for (const identifier of identifiers)
      if (!frameworkIdentifier(key, identifier))
        throw new Error(`framework identifier '${identifier}' is malformed for ${key}`)
    index[key] = new Set(identifiers)
  }
  return index
}

async function validatePublishedSkillInventory(entries: readonly string[]): Promise<void> {
  const filename = path.join(documentationRoot, "runtimes/skill-catalog.md")
  if (!await Bun.file(filename).exists()) {
    if (configuredDocumentationRoot) {
      throw new Error(`configured documentation root does not contain runtimes/skill-catalog.md: ${documentationRoot}`)
    }
    return
  }
  const source = await Bun.file(filename).text()
  const rows = [...source.matchAll(/^- `((?:test|audit|trace|analyze|operate|assess|plan|report)-[^`]+)` - `([^`]+)`$/gm)].map(
    (match) => ({ name: match[1] ?? "", category: match[2] ?? "" }),
  )
  if (rows.map((row) => row.name).toSorted().join("\0") !== entries.join("\0"))
    throw new Error(`published skill inventory must list each of the ${EXPECTED_SKILL_NAMES.length} packages exactly once`)
  for (const row of rows) {
    const sourceFile = path.join(skillRoot, row.name, "SKILL.md")
    const data = record(matter(await Bun.file(sourceFile).text()).data, `${row.name} published inventory frontmatter`)
    const metadata = record(data.metadata, `${row.name} published inventory metadata`)
    const category = stringValue(metadata.subdomain ?? metadata.domain, `${row.name} published inventory category`)
    if (row.category !== category)
      throw new Error(`${row.name} published inventory category must match its discovery category '${category}'`)
  }
}

async function validateScriptManifest(packageRoot: string, skillName: string): Promise<void> {
  const scriptsRoot = path.join(packageRoot, "scripts")
  const entries = await readdir(scriptsRoot, { withFileTypes: true }).catch(() => [])
  const scripts = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".py")).map((entry) => entry.name)
  if (scripts.length === 0) return
  if (scripts.length !== 1) throw new Error(`${skillName} scripts/ must contain exactly one Python entrypoint`)
  const manifest = record(
    JSON.parse(await Bun.file(path.join(scriptsRoot, "manifest.json")).text()),
    `${skillName} script manifest`,
  )
  if (manifest.schema_version !== 1) throw new Error(`${skillName} script manifest schema_version must be 1`)
  const entrypoint = stringValue(manifest.entrypoint, `${skillName} script entrypoint`)
  if (entrypoint !== scripts[0]) throw new Error(`${skillName} script manifest entrypoint does not match scripts/`)
  const scriptClass = stringValue(manifest.class, `${skillName} class`)
  if (!["analysis", "harness", "probe", "orchestrator"].includes(scriptClass))
    throw new Error(`${skillName} script class is unsupported`)
  const network = stringValue(manifest.network, `${skillName} network`)
  if (!["none", "loopback", "target"].includes(network)) throw new Error(`${skillName} script network is unsupported`)
  if (network === "target") {
    const transport = record(manifest.transport, `${skillName} target transport`)
    if (transport.authority !== "runtime" || transport.loopback !== "direct")
      throw new Error(`${skillName} target transport must be runtime-authorized with direct literal loopback`)
    const route = stringValue(transport.route, `${skillName} target transport route`)
    if (!["http-proxy", "target-network"].includes(route))
      throw new Error(`${skillName} target transport route must be http-proxy or target-network`)
    const proxyEnvironment = stringList(transport.proxy_environment, `${skillName} target proxy environment`, 0, 2)
    const trustEnvironment = stringList(transport.trust_environment, `${skillName} target trust environment`, 0, 2)
    if (route === "http-proxy") {
      if (proxyEnvironment.join("\0") !== "HTTP_PROXY\0HTTPS_PROXY")
        throw new Error(`${skillName} HTTP target transport must use HTTP_PROXY and HTTPS_PROXY in canonical order`)
      if (trustEnvironment.join("\0") !== "SSL_CERT_FILE\0CURL_CA_BUNDLE")
        throw new Error(`${skillName} HTTP target transport must use SSL_CERT_FILE and CURL_CA_BUNDLE in canonical order`)
    } else if (proxyEnvironment.length > 0 || trustEnvironment.length > 0) {
      throw new Error(`${skillName} target-network transport must not declare HTTP proxy or CA environment`)
    }
  } else if (manifest.transport !== undefined) {
    throw new Error(`${skillName} may declare target transport only when network is target`)
  }
  const declaredWorkflows = stringList(manifest.workflows, `${skillName} workflows`, 1, 3)
  for (const workflow of declaredWorkflows)
    if (!workflows.has(workflow)) throw new Error(`${skillName} declares unknown workflow '${workflow}'`)
  if (scriptClass === "analysis" && network !== "none")
    throw new Error(`${skillName} analysis scripts must remain offline`)
  if (network === "target" && declaredWorkflows.includes("code-audit"))
    throw new Error(`${skillName} cannot expose target networking to Code Audit`)
  for (const phase of stringList(manifest.phases, `${skillName} phases`, 1, 11))
    if (!phases.has(phase)) throw new Error(`${skillName} declares unknown phase '${phase}'`)
  stringList(manifest.tools, `${skillName} tools`, 0, 16)
  const dependencies = record(manifest.dependencies, `${skillName} dependencies`)
  stringList(dependencies.commands, `${skillName} command dependencies`, 0, 32)
  stringList(dependencies.python, `${skillName} Python dependencies`, 0, 32)
  if (dependencies.bootstrap !== null) {
    const bootstrap = record(dependencies.bootstrap, `${skillName} bootstrap`)
    const requirements = stringValue(bootstrap.requirements, `${skillName} bootstrap requirements`)
    await packageRegularFile(packageRoot, requirements, `${skillName} bootstrap requirements`)
    const argumentsList = stringList(bootstrap.installer_args, `${skillName} bootstrap installer arguments`, 3, 8)
    for (const required of ["--require-hashes", "--only-binary=:all:", "--no-deps"])
      if (!argumentsList.includes(required)) throw new Error(`${skillName} bootstrap is missing ${required}`)
    if (bootstrap.ephemeral_venv !== true) throw new Error(`${skillName} bootstrap must use an ephemeral venv`)
  }
  stringList(manifest.effects, `${skillName} effects`, 1, 16)
  if (!Number.isSafeInteger(manifest.timeout_seconds) || Number(manifest.timeout_seconds) <= 0)
    throw new Error(`${skillName} timeout_seconds must be a positive integer`)
  const limits = record(manifest.limits, `${skillName} limits`)
  if (!Number.isSafeInteger(limits.requests) || Number(limits.requests) < 0)
    throw new Error(`${skillName} request limit must be a non-negative integer`)
  if (!Number.isSafeInteger(limits.concurrency) || Number(limits.concurrency) < 1)
    throw new Error(`${skillName} concurrency limit must be a positive integer`)
  if (!Number.isSafeInteger(limits.output_bytes) || Number(limits.output_bytes) < 1)
    throw new Error(`${skillName} output limit must be a positive integer`)
  if (network === "none" && limits.requests !== 0) throw new Error(`${skillName} offline analysis must declare zero requests`)
  const secretEnvironment = stringList(
    record(manifest.secrets, `${skillName} secrets`).environment,
    `${skillName} secret environment`,
    0,
    32,
  )
  for (const variable of secretEnvironment)
    if (!/^[A-Z][A-Z0-9_]*$/.test(variable))
      throw new Error(`${skillName} secret environment variable '${variable}' is malformed`)
  if (network === "target")
    for (const variable of secretEnvironment)
      if (runtimeTransportEnvironment.test(variable))
        throw new Error(`${skillName} must inherit transport '${variable}' from the runtime instead of declaring it as a skill secret`)
  for (const direction of ["input", "output"] as const) {
    const contract = record(manifest[direction], `${skillName} ${direction}`)
    stringValue(contract.format, `${skillName} ${direction} format`)
    const schema = stringValue(contract.schema, `${skillName} ${direction} schema`)
    const schemaFilename = await packageRegularFile(packageRoot, schema, `${skillName} ${direction} schema`, "assets")
    const schemaSource = JSON.parse(await Bun.file(schemaFilename).text())
    const schemaValidator = compileSchema(schemaSource, `${skillName} ${direction} schema`)
    if (direction === "input") {
      const examplePath = schema.replace(/\.schema\.json$/, ".example.json")
      if (examplePath === schema) throw new Error(`${skillName} input schema must end in .schema.json`)
      const exampleFilename = await packageRegularFile(packageRoot, examplePath, `${skillName} input example`, "assets")
      const example = JSON.parse(await Bun.file(exampleFilename).text())
      if (!schemaValidator(example))
        throw new Error(`${skillName} input example violates its schema: ${JSON.stringify(schemaValidator.errors)}`)
    }
    if (direction === "input" && network === "target") {
      const forbidden = nestedObjectKeys(schemaSource).find((key) => modelSelectedTransportFields.has(key))
      if (forbidden)
        throw new Error(`${skillName} target input schema must not expose model-selected transport field '${forbidden}'`)
    }
    if (direction === "output" && contract.raw !== true) throw new Error(`${skillName} output must preserve raw evidence`)
  }
  const scriptSource = await Bun.file(path.join(scriptsRoot, entrypoint)).text()
  if (/shell\s*=\s*True/.test(scriptSource)) throw new Error(`${skillName} script must not enable a shell`)
  if (/os\.environ\.copy\s*\(/.test(scriptSource))
    throw new Error(`${skillName} script must construct an explicit child environment allowlist`)
  if (/\.communicate\s*\(/.test(scriptSource))
    throw new Error(`${skillName} script must stream and bound child-process output during execution`)
  if (/verify\s*=\s*False|CERT_NONE|_create_unverified_context/.test(scriptSource))
    throw new Error(`${skillName} script must not disable TLS verification`)
  await regularFile(path.join(packageRoot, "tests", `test_${path.basename(entrypoint, ".py")}.py`), `${skillName} script test`)
}

async function validateSkill(
  packageRoot: string,
  directoryName: string,
  frameworkIdentifiers: FrameworkIdentifierIndex,
  usedFrameworkIdentifiers?: Record<FrameworkKey, Set<string>>,
): Promise<void> {
  const skillFile = path.join(packageRoot, "SKILL.md")
  await regularFile(skillFile, `${directoryName} SKILL.md`)
  const source = await Bun.file(skillFile).text()
  const parsed = matter(source)
  const data = record(parsed.data, `${directoryName} frontmatter`)
  const name = stringValue(data.name, `${directoryName} name`)
  if (name !== directoryName) throw new Error(`${directoryName} frontmatter name must match its directory`)
  if (name.length > 64 || !intentPattern.test(name)) throw new Error(`${name} does not use the first-party intent vocabulary`)
  const description = stringValue(data.description, `${name} description`).replace(/\s+/g, " ")
  if (description.length < 64) throw new Error(`${name} description must contain at least 64 characters`)
  const metadata = record(data.metadata, `${name} metadata`)
  stringValue(metadata.domain, `${name} domain`)
  stringValue(metadata.subdomain, `${name} subdomain`)
  const triggers = stringList(metadata.triggers, `${name} triggers`, 4, 8)
  stringList(metadata.tags, `${name} tags`, 2, 12)
  if (Array.from(`${description}${triggers.join(", ")}`).length > 1_536)
    throw new Error(`${name} description and triggers exceed 1,536 characters`)
  const mappings = record(metadata.frameworks, `${name} frameworks`)
  for (const [key, value] of Object.entries(mappings)) {
    if (!frameworkKeys.includes(key as (typeof frameworkKeys)[number])) throw new Error(`${name} framework '${key}' is unsupported`)
    const identifiers = stringList(value, `${name} ${key} mappings`, 1, 32)
    for (const identifier of identifiers)
      if (!frameworkIdentifier(key as (typeof frameworkKeys)[number], identifier))
        throw new Error(`${name} framework identifier '${identifier}' is malformed for ${key}`)
      else if (!frameworkIdentifiers[key as FrameworkKey].has(identifier))
        throw new Error(`${name} framework identifier '${identifier}' is not in the reviewed ${key} snapshot index`)
      else usedFrameworkIdentifiers?.[key as FrameworkKey].add(identifier)
  }
  const adapter = record(Bun.YAML.parse(await Bun.file(path.join(packageRoot, "agents", "openai.yaml")).text()), `${name} openai.yaml`)
  const ui = record(adapter.interface, `${name} openai.yaml interface`)
  stringValue(ui.display_name, `${name} display_name`)
  const shortDescription = stringValue(ui.short_description, `${name} short_description`)
  if (shortDescription.length < 25 || shortDescription.length > 64)
    throw new Error(`${name} short_description must contain 25–64 characters`)
  if (!stringValue(ui.default_prompt, `${name} default_prompt`).includes(`$${name}`))
    throw new Error(`${name} default_prompt must mention $${name}`)
  await validateLinks(packageRoot, skillFile, source, name)
  for (const referenceFile of await markdownReferences(path.join(packageRoot, "references"))) {
    const referenceSource = await Bun.file(referenceFile).text()
    await validateLinks(packageRoot, referenceFile, referenceSource, `${name} ${path.relative(packageRoot, referenceFile)}`)
  }
  if ((NEW_SKILL_NAMES as readonly string[]).includes(name)) {
    const references = await readdir(path.join(packageRoot, "references"), { withFileTypes: true }).catch(() => [])
    if (!references.some((entry) => entry.isFile())) throw new Error(`${name} must contain a focused reference`)
  }
  await validateScriptManifest(packageRoot, name)
}

export async function validateBuiltInSkills(root = skillRoot): Promise<void> {
  const sourceDigests = await validateFrameworkSources(root)
  const frameworkIdentifiers = await validateFrameworkIdentifiers(root, sourceDigests)
  const usedFrameworkIdentifiers = Object.fromEntries(frameworkKeys.map((key) => [key, new Set<string>()])) as Record<
    FrameworkKey,
    Set<string>
  >
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
  if (entries.join("\0") !== EXPECTED_SKILL_NAMES.join("\0"))
    throw new Error(
      `built-in skill catalog must contain exactly the expected ${EXPECTED_SKILL_NAMES.length} packages; found ${entries.length}`,
    )
  for (const name of entries)
    await validateSkill(path.join(root, name), name, frameworkIdentifiers, usedFrameworkIdentifiers)
  for (const key of frameworkKeys) {
    const reviewed = [...frameworkIdentifiers[key]].toSorted()
    const used = [...usedFrameworkIdentifiers[key]].toSorted()
    if (reviewed.join("\0") !== used.join("\0"))
      throw new Error(
        `framework identifier '${key}' index must contain exactly the identifiers used by the ${EXPECTED_SKILL_NAMES.length} skills`,
      )
  }
  if (path.resolve(root) === skillRoot) await validatePublishedSkillInventory(entries)
}

export async function validateSkillPackages(names: readonly string[], root = skillRoot): Promise<void> {
  const sourceDigests = await validateFrameworkSources(root)
  const frameworkIdentifiers = await validateFrameworkIdentifiers(root, sourceDigests)
  const selected = [...new Set(names)].toSorted()
  if (selected.length !== names.length) throw new Error("skill package validation selection must not contain duplicates")
  for (const name of selected) {
    if (!(EXPECTED_SKILL_NAMES as readonly string[]).includes(name))
      throw new Error(`unknown built-in skill package '${name}'`)
    await validateSkill(path.join(root, name), name, frameworkIdentifiers)
  }
}

if (import.meta.main) {
  await validateBuiltInSkills()
  console.log(`Validated ${EXPECTED_SKILL_NAMES.length} built-in skill packages.`)
}
