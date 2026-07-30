// ── Phase Gateway MCP Server ────────────────────────────────────────────────
// Runs the session-scoped MCP bridge for variables, handoffs, questions, usage
// recording, and hardened proxying to browser, ZAP, Ghidra, and execution runtimes.
// Template resolution and response redaction keep stored secrets out of model traffic.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import path from "node:path"
import os from "node:os"
import { lstat, readFile, writeFile } from "node:fs/promises"
import { SubsystemPhase } from "../phase"
import { SubsystemBrowserCdp } from "../browser-cdp"
import { BrowserProfile, type BrowserProfileId } from "@/dependency/browser-profile"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import { and, asc, eq } from "drizzle-orm"
import { Database } from "../../storage/db"
import { SessionVariableTable } from "../../session/session.sql"
import { SessionVariable } from "../../session/variable"
import { SubsystemCompletion } from "../completion"
import { SubsystemVerdict } from "../verdict"
import { SubsystemUpstream } from "../upstream"
import { SessionID } from "../../session/schema"
import { ToolUsageRecorder, type ToolUsageEvent } from "./tool-usage"
import { ownedProcessTree, processSnapshot, reapCapturedProcessTree } from "./mcp-process-owner"
import { EgressObservation, EGRESS_OBSERVATION_TOOL_DEF } from "./egress-observation"
import { SurfaceCoverage, browserAction } from "./surface-coverage"
import { HYPOTHESIS_TOOL_DEF, HypothesisRegistry } from "./hypothesis-registry"
import {
  applyEngagementRateLimit,
  ENGAGEMENT_POLICY_TOOL_DEF,
  EngagementPolicyStore,
  readEngagementPolicy,
  type EngagementPolicy,
  ZapRateLimitInstallError,
} from "./engagement-policy"
import {
  TEST_OBJECT_TOOL_DEF,
  testObjectLifecycleFromEnvironment,
  type TestObjectLifecycleLedger,
} from "./test-object-lifecycle"
import { SubsystemNovelty } from "../novelty"
import * as Log from "@/util/log"
import { errorMessage } from "@/util/error"
import { SOURCE_TOOL_DEFS, handleSourceTool, isSourceTool, sourceToolsAvailable } from "./source-tools"
import { SOURCE_IMPORT_TOOL_DEF, handleSourceImport, type SourceImportRequest } from "./source-import"
import { GIT_TOOL_DEFS, gitToolsAvailable, handleGitTool, isGitTool } from "./git-tools"
import { AUDIT_LAB_TOOL_DEF, auditLabAvailable, cleanupAuditLabs, prepareAuditLab } from "./audit-lab"
import { EVM_LAB_TOOL_DEF, evmLabAvailable, handleEvmLab } from "./evm-lab"
import { EVM_EVIDENCE_TOOL_DEF, evmEvidenceAvailable, handleEvmEvidence } from "./evm-evidence"
import { GhidraEvidenceRecorder } from "./ghidra-evidence"
import { evmVariableRegistryName } from "../evm/runtime"
import {
  CODE_GRAPH_TOOL_DEFS,
  codeGraphToolsAvailable,
  createCodeGraphToolHandler,
  isCodeGraphTool,
} from "./code-graph-tools"
import {
  acknowledgeCircuitBreaker,
  activateCircuitBreaker,
  circuitBreakerError,
  clearCircuitBreaker,
  dismissCircuitBreaker,
  readCircuitBreaker,
  type CircuitBreakerState,
} from "./circuit-breaker"
import {
  approvalElicitationMetadata,
  approvalElicitationSchema,
  hasHumanDecisionMetadata,
  parseApprovalElicitationContent,
  parseHumanQuestions,
  type HumanQuestion,
} from "../human-question"
import { gatewayPhasePolicy, runtimeNetworkAllowed, type GatewayPhasePolicy } from "./phase-policy"
import { GatewayToolRegistry } from "./tool-registry"

export { runtimeCapabilityAllowed, runtimeNetworkAllowed } from "./phase-policy"

const log = Log.create({ service: "phase-gateway" })
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_CLEANUP_OUTPUT_BYTES = 64 * 1024

// ── Gateway Startup Rejects Unscoped Or Invalid Authority ───────────
// A gateway may access variables for exactly one host-supplied session. Missing
// identity is a hard error because an unscoped default could read or overwrite
// another engagement. Private configuration arrives through an owner-only file
// outside the workarea, but remains untrusted transport until its path, object
// shape, environment names, and string values have all been validated.
// ──────────────────────────────────────────────────────────────
function boundSession(): SessionID {
  const id = process.env.CYBERFUL_SUBSYSTEM_SESSION?.trim()
  if (!id) throw new Error("expert-gateway requires CYBERFUL_SUBSYSTEM_SESSION")
  return SessionID.make(id)
}

export async function loadPrivateGatewayEnvironment(filePath = process.env.CYBERFUL_SUBSYSTEM_ENV_PATH?.trim()) {
  if (!filePath) return
  if (!path.isAbsolute(filePath)) throw new Error("expert-gateway environment path must be absolute")
  const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"))
  if (!isRecord(parsed)) throw new Error("expert-gateway environment must be a JSON object")
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string")
      throw new Error("expert-gateway environment contains an invalid entry")
    process.env[key] = value
  }
}

const table = SessionVariableTable

// All rows for the session, unordered — used to build the {{var}} lookup map and the redaction set.
function allRows(sessionID: SessionID) {
  return Database.use((db) => db.select().from(table).where(eq(table.session_id, sessionID)).all())
}

function visibleRows(sessionID: SessionID) {
  return allRows(sessionID).filter((row) => !SessionVariable.isHostOwnedName(row.name))
}

function listVars(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(table).where(eq(table.session_id, sessionID)).orderBy(asc(table.name)).all(),
  )
    .filter((row) => !SessionVariable.isHostOwnedName(row.name))
    .map(SessionVariable.toSummary)
}

function getVar(sessionID: SessionID, name: string) {
  const row = Database.use((db) =>
    db
      .select()
      .from(table)
      .where(and(eq(table.session_id, sessionID), eq(table.name, name)))
      .get(),
  )
  return row ? SessionVariable.toInfo(row) : undefined
}

function setVar(sessionID: SessionID, name: SessionVariable.Name, value: SessionVariable.Value, description?: string) {
  const row = Database.transaction((db) => {
    const current = db
      .select()
      .from(table)
      .where(and(eq(table.session_id, sessionID), eq(table.name, name)))
      .get()
    const next: SessionVariable.Row = {
      session_id: sessionID,
      name,
      source_message_id: current?.source_message_id ?? null,
      description: description ?? current?.description ?? null,
      value,
    }
    if (current) {
      db.update(table)
        .set({ source_message_id: next.source_message_id, description: next.description, value })
        .where(and(eq(table.session_id, sessionID), eq(table.name, name)))
        .run()
    } else {
      db.insert(table).values(next).run()
    }
    return next
  })
  return SessionVariable.toSummary(row)
}

function deleteVar(sessionID: SessionID, name: string) {
  return Database.transaction((db) => {
    const row = db
      .select({ name: table.name })
      .from(table)
      .where(and(eq(table.session_id, sessionID), eq(table.name, name)))
      .get()
    if (!row) return false
    db.delete(table)
      .where(and(eq(table.session_id, sessionID), eq(table.name, name)))
      .run()
    return true
  })
}

function text(value: unknown, isError = false) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: "text" as const, text: body }], ...(isError ? { isError: true } : {}) }
}

function liveTargetToolDefinitions(input: {
  testObjects: boolean
  egress: boolean
  hypothesis: boolean
  engagementPolicy: boolean
}) {
  return [
    ...(input.testObjects ? [TEST_OBJECT_TOOL_DEF] : []),
    ...(input.egress ? [EGRESS_OBSERVATION_TOOL_DEF] : []),
    ...(input.hypothesis ? [HYPOTHESIS_TOOL_DEF] : []),
    ...(input.engagementPolicy ? [ENGAGEMENT_POLICY_TOOL_DEF] : []),
  ]
}

function localToolDefinitions(
  policy: GatewayPhasePolicy,
  input: {
    testObjects: boolean
    egress: boolean
    hypothesis: boolean
    engagementPolicy: boolean
  },
) {
  if (!policy.active) return []
  const source = sourceToolsAvailable() && policy.allows("source") ? [...SOURCE_TOOL_DEFS] : []
  const sourceImport = policy.sourceImport ? [SOURCE_IMPORT_TOOL_DEF] : []
  const git = gitToolsAvailable() && policy.auditDiff ? [...GIT_TOOL_DEFS] : []
  const codeGraph = codeGraphToolsAvailable() && policy.allows("code-graph") ? [...CODE_GRAPH_TOOL_DEFS] : []
  const lab = policy.auditLab && auditLabAvailable() ? [AUDIT_LAB_TOOL_DEF] : []
  const evmLab = policy.evmLab && evmLabAvailable() ? [EVM_LAB_TOOL_DEF] : []
  const evmEvidence = policy.evmEvidence && evmEvidenceAvailable() ? [EVM_EVIDENCE_TOOL_DEF] : []
  return [
    ...sourceImport,
    ...source,
    ...codeGraph,
    ...git,
    ...lab,
    ...evmLab,
    ...evmEvidence,
    ...liveTargetToolDefinitions(input),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nodeErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function settleOperations(label: string, operations: ReadonlyArray<() => Promise<void>>) {
  const outcomes = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)))
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    .map((outcome): unknown => outcome.reason)
  if (failures.length > 0) throw new AggregateError(failures, label)
}

async function collectUpstreamLists<T>(
  label: string,
  clients: readonly Client[],
  load: (client: Client) => Promise<T[]>,
) {
  const outcomes = await Promise.allSettled(clients.map(load))
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
  if (failures.length === clients.length && failures.length > 0)
    throw new AggregateError(
      failures.map((outcome): unknown => outcome.reason),
      `all upstreams failed while listing ${label}`,
    )
  if (failures.length > 0)
    log.warn(`some upstreams failed while listing ${label}`, {
      failures: failures.map((outcome) => outcome.reason),
    })
  return outcomes
    .filter((outcome): outcome is PromiseFulfilledResult<T[]> => outcome.status === "fulfilled")
    .map((outcome) => outcome.value)
}

function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string")
}

const VARIABLE_TOOL_DEF = {
  name: "variable",
  description:
    "Read and write this session's variable store — the same store the rest of the engagement shares " +
    "across its agents. Save long, secret, or reused values (auth tokens, a target base URL, IDs, " +
    "request bodies) here, then reference them as {{var:name}} in later tool arguments (including the " +
    "proxied cyberful-os/browser tools) instead of pasting raw values. Actions: set | get | list | delete.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["set", "get", "list", "delete"] },
      name: { type: "string", description: "Variable name (required for set/get/delete)." },
      value: { description: "JSON value to store (required for set)." },
      description: {
        type: "string",
        maxLength: SessionVariable.MAX_DESCRIPTION_LENGTH,
        description: `Optional note stored with the variable (at most ${SessionVariable.MAX_DESCRIPTION_LENGTH} characters).`,
      },
      reveal: { type: "boolean", description: "get only: return the raw value instead of a redacted preview." },
    },
    required: ["action"],
  },
}

interface CircuitBreakerConfig {
  filePath: string
  phase: string
}

function questionEnabled(): boolean {
  const enabled = process.env.CYBERFUL_SUBSYSTEM_QUESTION_ENABLED?.trim()
  if (!enabled) return false
  if (enabled !== "1") throw new Error("expert-gateway question flag must be 1")
  return true
}

function circuitBreakerConfig(): CircuitBreakerConfig | undefined {
  const filePath = process.env.CYBERFUL_SUBSYSTEM_CIRCUIT_BREAKER_PATH?.trim()
  if (!filePath) return undefined
  if (!path.isAbsolute(filePath)) throw new Error("expert-gateway circuit breaker path must be absolute")
  return { filePath, phase: process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim() || "unknown" }
}

const QUESTION_TOOL_DEF = {
  name: "question",
  description:
    "Ask the human one short decision or tightly coupled batch and wait for the answer. Use this only when a decision, " +
    "authorization, or missing fact cannot be discovered safely from the engagement context. " +
    "Never combine authorities that differ by host, method, identity, credential, effect, risk, or traffic bound; " +
    "each independent authority requires a separate call that states those fields. " +
    "The host suspends the phase execution and budget while the TUI or external approval selector " +
    "returns the selected labels or a custom answer. For a CAPTCHA, " +
    "first make the normal action that displays it, call browser_captcha_handoff, then use kind=captcha.",
  inputSchema: {
    type: "object" as const,
    properties: {
      kind: {
        type: "string",
        enum: ["question", "captcha"],
        default: "question",
        description: "captcha is accepted only after the browser has attested a visible challenge.",
      },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "Very short label, at most 30 characters." },
            question: { type: "string", description: "Complete question shown to the human." },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Concise choice label." },
                  description: { type: "string", description: "Impact or meaning of the choice." },
                },
                required: ["label", "description"],
              },
            },
            multiple: { type: "boolean", description: "Allow more than one option." },
            custom: { type: "boolean", description: "Allow a free-form answer; defaults to true." },
          },
          required: ["header", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
}

async function handleQuestion(
  server: Server,
  circuit: CircuitBreakerConfig | undefined,
  args: Record<string, unknown>,
) {
  const questions = parseHumanQuestions(args.questions)
  if (!questions) return text({ error: "question requires one to three valid questions" })
  const captcha = args.kind === "captcha"
  let captchaState: CircuitBreakerState | undefined
  if (captcha) {
    captchaState = circuit ? await readCircuitBreaker(circuit.filePath) : undefined
    if (!captchaState || captchaState.status === "cleared" || !captchaState.surfacedAt)
      return text(
        {
          error:
            "A CAPTCHA question requires an already visible, host-attested challenge. Trigger it through the normal page action and call browser_captcha_handoff first.",
        },
        true,
      )
  }
  const presentedQuestions: HumanQuestion[] = captcha
    ? [
        {
          header: "CAPTCHA",
          question: "Resolve the visible CAPTCHA in the browser Cyberful brought to the front, then confirm here.",
          options: [
            { label: "Resolved", description: "I completed the visible challenge in that browser." },
            {
              label: "No challenge visible",
              description: "I checked the surfaced browser and no CAPTCHA or human challenge is visible.",
            },
            { label: "Cannot resolve", description: "Keep this browser profile and origin paused." },
          ],
          custom: false,
        },
      ]
    : questions
  const response = await server.elicitInput({
    mode: "form",
    message:
      presentedQuestions.length === 1
        ? (presentedQuestions[0]?.question ?? "Cyberful requires a human decision.")
        : `Cyberful requires ${presentedQuestions.length} related human decisions.`,
    requestedSchema: approvalElicitationSchema(presentedQuestions),
    _meta: approvalElicitationMetadata(presentedQuestions),
  })
  if (response.action !== "accept")
    return text({
      ok: false,
      action: response.action,
      output:
        response.action === "decline" && hasHumanDecisionMetadata(response._meta)
          ? "The human explicitly declined this request. Do not perform the proposed action."
          : response.action === "decline"
            ? "The request was declined before Cyberful received an explicit human decision. Do not perform the proposed action."
            : "The human interaction was cancelled. Do not perform the proposed action.",
    })
  const answers = parseApprovalElicitationContent(presentedQuestions, response.content)
  if (!answers) return text({ error: "native elicitation returned invalid answers" }, true)
  const captchaAnswer = captcha ? answers[0]?.[0] : undefined
  let captchaDecisionApplied: boolean | undefined
  if (captcha && circuit && captchaState && captchaAnswer === "Resolved")
    captchaDecisionApplied = await acknowledgeCircuitBreaker(circuit.filePath, captchaState)
  if (captcha && circuit && captchaState && captchaAnswer === "No challenge visible")
    captchaDecisionApplied = await dismissCircuitBreaker(circuit.filePath, captchaState)
  return text({
    ok: true,
    answers: presentedQuestions.map((question, index) => ({
      question: question.question,
      answers: answers[index] ?? [],
    })),
    output: captcha
      ? captchaDecisionApplied === false
        ? "The CAPTCHA state changed before this answer arrived, so the decision was not applied. Inspect and answer the current request."
        : captchaAnswer === "Resolved"
          ? "The human resolved the challenge. Call browser_captcha_status on the original page; only that profile and origin remain paused until clearance."
          : captchaAnswer === "No challenge visible"
            ? "The human confirmed that no challenge is visible. The false-positive pause is cleared; continue without treating passive provider signals as a CAPTCHA."
            : "The human could not resolve the challenge. Keep this browser profile and origin paused."
      : "The human answered. Continue the current phase using these answers.",
  })
}

async function confirmSourceImport(
  server: Server,
  question: boolean,
  circuit: CircuitBreakerConfig | undefined,
  request: SourceImportRequest,
) {
  if (!question) return false
  const refs = [request.checkoutRef, ...request.additionalRefs].filter(Boolean).join(", ") || "default HEAD"
  const result = await handleQuestion(server, circuit, {
    questions: [
      {
        header: "Import source",
        question:
          `Clone public repository '${request.repository}' from ${request.url} at ${refs} into the isolated source collection? ` +
          `Declared submodules are ${request.submodules === "recursive" ? "included at their exact Gitlink commits" : "not included"}; ` +
          "hooks, credentials, redirects, LFS and dependency execution stay disabled.",
        options: [
          { label: "Import repository", description: "Acquire and seal the displayed public Git source." },
          { label: "Keep local only", description: "Do not make a network request; use the current local source." },
        ],
        custom: false,
      },
    ],
  })
  const content = result.content[0]
  if (!content || content.type !== "text") return false
  const parsed = jsonRecord(content.text)
  const answers = parsed?.answers
  return Array.isArray(answers) && isRecord(answers[0]) && isStringArray(answers[0].answers)
    ? answers[0].answers.includes("Import repository")
    : false
}

interface HandoffConfig {
  phase: string
  workflow?: string
  successor?: string
  signalPath: string
  workareaRoot?: string
  artifact?: string
}

function handoffConfig(): HandoffConfig | undefined {
  const phase = process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim()
  const signalPath = process.env.CYBERFUL_SUBSYSTEM_HANDOFF_PATH?.trim()
  if (!phase || !signalPath) return undefined
  if (!path.isAbsolute(signalPath)) throw new Error("expert-gateway handoff path must be absolute")
  const successor = process.env.CYBERFUL_SUBSYSTEM_HANDOFF_SUCCESSOR?.trim()
  const terminal = process.env.CYBERFUL_SUBSYSTEM_HANDOFF_TERMINAL === "1"
  if (Boolean(successor) === terminal)
    throw new Error("expert-gateway handoff requires exactly one successor or terminal marker")
  const workareaRoot = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (workareaRoot && !path.isAbsolute(workareaRoot))
    throw new Error("expert-gateway workarea root must be absolute")
  const artifact = process.env.CYBERFUL_SUBSYSTEM_HANDOFF_ARTIFACT?.trim()
  if (artifact && (path.isAbsolute(artifact) || artifact.split(/[\\/]+/).includes("..")))
    throw new Error("expert-gateway handoff artifact must be a relative workarea path")
  if (artifact && !workareaRoot)
    throw new Error("expert-gateway handoff artifact validation requires the workarea root")
  return { phase, workflow: gatewayPhasePolicy().workflow, successor, signalPath, workareaRoot, artifact }
}

function handoffToolDef(config: HandoffConfig) {
  const destination = config.successor ? `the ${config.successor} phase` : "engagement completion"
  return {
    name: "handoff",
    description:
      `Complete the current phase and hand control to ${destination}. Call this exactly once, only after ` +
      "the required deliverable is complete. The host validates the destination and advances the chain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Concise structured summary for the next phase; it reads the artifact for full detail.",
        },
        artifact: {
          type: "string",
          description: config.artifact
            ? `Exact required phase deliverable: ${config.artifact}.`
            : "Relative path to the phase deliverable or workarea artifact.",
        },
        target: {
          type: "string",
          description: config.successor
            ? `Optional; when supplied it must be exactly ${config.successor}.`
            : "Terminal phase only; omit this field or set it to complete.",
        },
        completion: {
          type: "object",
          description: "Terminal presentation for the durable completion card.",
          properties: {
            title: { type: "string" },
            summaryMarkdown: { type: "string" },
            artifacts: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: { label: { type: "string" }, path: { type: "string" } },
                required: ["label", "path"],
              },
            },
          },
          required: ["title", "summaryMarkdown"],
        },
        verdicts: {
          ...SubsystemVerdict.INPUT_SCHEMA,
          description:
            "Deprecated compatibility input. New phases derive this inventory from the canonical hypothesis registry.",
        },
      },
      required: ["summary", ...(config.artifact ? ["artifact"] : [])],
    },
  }
}

async function handleHandoff(
  config: HandoffConfig,
  args: Record<string, unknown>,
  guards: {
    testObjects?: TestObjectLifecycleLedger
    hypotheses?: HypothesisRegistry
    coverage?: SurfaceCoverage
    engagementPolicy?: EngagementPolicy
    engagementPolicyRequired?: boolean
  } = {},
) {
  const summary = typeof args.summary === "string" ? args.summary.trim() : ""
  if (!summary) return text({ error: "handoff requires a non-empty summary" })
  const target = typeof args.target === "string" ? args.target.trim() : undefined
  if (config.successor && target && target !== config.successor)
    return text({ error: `handoff target '${target}' is not allowed; expected '${config.successor}'` })
  if (!config.successor && target && target !== "complete")
    return text({ error: `terminal handoff target '${target}' is not allowed; use 'complete' or omit target` })
  const artifact = typeof args.artifact === "string" ? args.artifact.trim() : undefined
  if (artifact && (path.isAbsolute(artifact) || artifact.split(/[\\/]+/).includes("..")))
    return text({ error: "handoff artifact must be a relative path inside the workarea" })
  if (config.artifact && artifact !== config.artifact)
    return text({
      error: `handoff requires artifact '${config.artifact}' at the workarea root; inside cyberful-os use '/workspace/${config.artifact}'`,
    })
  const completion = args.completion === undefined ? undefined : SubsystemCompletion.parseCandidate(args.completion)
  if (args.completion !== undefined && !completion)
    return text({ error: "handoff completion requires a non-empty title and summaryMarkdown" })
  const rawVerdicts =
    args.verdicts ??
    (SubsystemVerdict.requiredFor(config.workflow, config.phase)
      ? await guards.hypotheses?.verdictInventory()
      : undefined)
  let verdicts: ReturnType<typeof SubsystemVerdict.parse>
  try {
    verdicts = SubsystemVerdict.parse(rawVerdicts)
  } catch (error) {
    return text({ error: error instanceof Error ? error.message : String(error) }, true)
  }
  if (SubsystemVerdict.requiredFor(config.workflow, config.phase) && !verdicts)
    return text({ error: "handoff requires a structured verdict inventory for this phase" }, true)
  const lifecycleError = await guards.testObjects?.handoffError()
  if (lifecycleError) return text({ error: lifecycleError }, true)
  const hypothesisError = await guards.hypotheses?.handoffError(config.successor)
  if (hypothesisError) return text({ error: hypothesisError }, true)
  if (guards.engagementPolicyRequired && !guards.engagementPolicy)
    return text(
      {
        error:
          "handoff requires engagement_policy set to succeed in this Brief; the host must enforce and persist the traffic policy first",
      },
      true,
    )
  const coverageError = await guards.coverage?.handoffError(guards.engagementPolicy)
  if (coverageError) return text({ error: coverageError }, true)
  // ── Handoff Acceptance Proves The Required Artifact Exists ──────
  // A model may successfully create a deliverable beneath the wrong nested
  // directory while believing it wrote to the workarea root. Recording the
  // signal first would end the AgentRun before the host discovers the missing
  // file, making an otherwise repairable path mistake terminal. The gateway
  // therefore validates the host-owned exact path before accepting handoff;
  // the phase runner still rechecks it after shutdown to close the race.
  //
  // @docs/concepts/execution-model.md
  // ────────────────────────────────────────────────────────────────
  if (config.artifact && config.workareaRoot) {
    const artifactPath = path.join(config.workareaRoot, config.artifact)
    try {
      const info = await lstat(artifactPath)
      if (!info.isFile() || info.size === 0)
        return text({
          error: `required deliverable '${config.artifact}' must be a non-empty regular file at the workarea root; inside cyberful-os use '/workspace/${config.artifact}'`,
        })
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT")
        return text({
          error: `required deliverable '${config.artifact}' is missing from the workarea root; inside cyberful-os write '/workspace/${config.artifact}' and retry handoff`,
        })
      return text(
        {
          error: `could not validate required deliverable '${config.artifact}': ${error instanceof Error ? error.message : String(error)}`,
        },
        true,
      )
    }
  }
  try {
    await writeFile(
      config.signalPath,
      JSON.stringify({
        phase: config.phase,
        successor: config.successor,
        summary,
        artifact,
        completion,
        verdicts: rawVerdicts,
        time: Date.now(),
      }),
      { flag: "wx" },
    )
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") return text({ error: "handoff was already recorded" })
    throw error
  }
  return text({
    ok: true,
    successor: config.successor ?? "complete",
    output: "Handoff accepted. Stop now; the host will validate the deliverable and advance the chain.",
  })
}

function handleVariable(sessionID: SessionID, args: Record<string, unknown>) {
  let name: SessionVariable.Name | undefined
  try {
    name = typeof args.name === "string" ? SessionVariable.Name.make(args.name) : undefined
  } catch (error) {
    if (error instanceof Error) return text({ error: "variable name must match [A-Za-z_][A-Za-z0-9_.-]{0,127}" }, true)
    throw error
  }
  const hostOwned = name?.startsWith("_cyberful_host_") === true
  switch (args.action) {
    case "set": {
      if (!name) return text({ error: "set requires 'name'" })
      if (hostOwned) return text({ error: "host-owned policy variables cannot be changed through MCP" }, true)
      if (args.value === undefined) return text({ error: "set requires 'value'" })
      let value: SessionVariable.Value
      try {
        value = SessionVariable.decodeValue(args.value)
      } catch (error) {
        return text(
          { error: `set requires a JSON value: ${error instanceof Error ? error.message : String(error)}` },
          true,
        )
      }
      const rejection = SessionVariable.unusableValueReason(value)
      if (rejection) return text({ error: `refusing to save '${name}': ${rejection}` }, true)
      if (args.description !== undefined && typeof args.description !== "string")
        return text({ error: "description must be a string" }, true)
      if (typeof args.description === "string" && args.description.length > SessionVariable.MAX_DESCRIPTION_LENGTH)
        return text(
          { error: `description must contain at most ${SessionVariable.MAX_DESCRIPTION_LENGTH} characters` },
          true,
        )
      return text({ ok: true, variable: setVar(sessionID, name, value, args.description) })
    }
    case "get": {
      if (!name) return text({ error: "get requires 'name'" })
      if (hostOwned) return text({ error: "host-owned policy variables cannot be read through MCP" }, true)
      const info = getVar(sessionID, name)
      if (!info) return text({ error: `no variable named ${name}` })
      return text(
        args.reveal
          ? { name: info.name, value: info.value }
          : { name: info.name, type: info.type, size: info.size, preview: info.preview },
      )
    }
    case "list":
      return text({ variables: listVars(sessionID) })
    case "delete": {
      if (!name) return text({ error: "delete requires 'name'" })
      if (hostOwned) return text({ error: "host-owned policy variables cannot be changed through MCP" }, true)
      return text({ deleted: deleteVar(sessionID, name) })
    }
    default:
      return text({ error: `unknown action ${String(args.action)}` })
  }
}

// An upstream tool re-exposed through the gateway: the definition the Expert sees, and how to invoke it.
export interface UpstreamTool {
  def: { name: string; description?: string; inputSchema: unknown; _meta?: unknown }
  capability?: SubsystemPhase.WorkflowCapability
  browserProfile?: BrowserProfileId
  call(args: Record<string, unknown>): Promise<CallToolResult>
}

// ── One Browser Surface Selects Five Isolated Identities ────────────
// Repeating every browser tool five times would obscure the useful tool surface
// and weaken existing prompts that already know the `browser_*` names. The
// gateway instead adds one bounded profile selector to each browser schema and
// removes it before forwarding the call to that profile's unmodified MCP tool.
// Profile one remains the default, preserving existing calls while natural
// references such as "the second browser profile" map directly to `profile: 2`.
// ─────────────────────────────────────────────────────────────────────
export function browserProfileToolDefinition(
  definition: UpstreamTool["def"],
  profiles: readonly BrowserProfileId[],
): UpstreamTool["def"] {
  if (!isRecord(definition.inputSchema)) return definition
  const properties = isRecord(definition.inputSchema.properties) ? definition.inputSchema.properties : {}
  return {
    ...definition,
    description: `${definition.description ?? "Use the isolated browser."} Select profile 1-5 for a distinct authenticated browser identity; profile 1 is the default.`,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...properties,
        profile: {
          type: "integer",
          enum: profiles,
          default: 1,
          description: "Isolated browser identity: 1 is the first profile, through 5 for the fifth profile.",
        },
      },
    },
  }
}

export function selectBrowserProfileUpstream(
  candidates: readonly UpstreamTool[],
  args: Record<string, unknown>,
): { upstream: UpstreamTool; args: Record<string, unknown> } {
  const profiled = candidates.filter(
    (candidate): candidate is UpstreamTool & { browserProfile: BrowserProfileId } =>
      candidate.browserProfile !== undefined,
  )
  if (profiled.length === 0) {
    const upstream = candidates[0]
    if (!upstream) throw new Error("browser tool has no available upstream")
    return { upstream, args }
  }

  const requested = args.profile ?? 1
  if (!BrowserProfile.isBrowserProfileId(requested)) {
    throw new Error("browser profile must be an integer from 1 through 5")
  }
  const upstream = profiled.find((candidate) => candidate.browserProfile === requested)
  if (!upstream) throw new Error(`browser profile ${requested} is unavailable`)
  return {
    upstream,
    args: Object.fromEntries(Object.entries(args).filter(([name]) => name !== "profile")),
  }
}

interface ToolArgumentAdjustment {
  readonly field: "max_output_bytes"
  readonly requested: number
  readonly applied: number
  readonly reason: "declared-maximum"
}

// ── One Safe Numeric Correction Happens Before Execution ────────
// cyberful-os publishes a hard maximum for retained command output, yet model calls
// can still exceed it. The gateway may lower only max_output_bytes using that
// exact advertised schema value, before the upstream sees the request. It never
// retries an executed call or normalizes other fields, so correction cannot
// duplicate side effects or weaken the upstream's validation boundary.
//
// ─────────────────────────────────────────────────────────────────
function adjustUpstreamArguments(definition: UpstreamTool["def"], args: Record<string, unknown>) {
  if (!isRecord(definition.inputSchema)) return { args, adjustments: [] as ToolArgumentAdjustment[] }
  const properties = isRecord(definition.inputSchema.properties) ? definition.inputSchema.properties : undefined
  const outputSchema = properties && isRecord(properties.max_output_bytes) ? properties.max_output_bytes : undefined
  const maximum = outputSchema?.maximum
  const requested = args.max_output_bytes
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum))
    return { args, adjustments: [] as ToolArgumentAdjustment[] }
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested <= maximum)
    return { args, adjustments: [] as ToolArgumentAdjustment[] }
  return {
    args: { ...args, max_output_bytes: maximum },
    adjustments: [
      { field: "max_output_bytes", requested, applied: maximum, reason: "declared-maximum" },
    ] satisfies ToolArgumentAdjustment[],
  }
}

function annotateAdjustments(result: CallToolResult, adjustments: readonly ToolArgumentAdjustment[]): CallToolResult {
  if (adjustments.length === 0) return result
  const existingMeta = isRecord(result._meta) ? result._meta : {}
  const existingCyberful = isRecord(existingMeta.cyberful) ? existingMeta.cyberful : {}
  const notice = adjustments
    .map((item) => `${item.field} reduced from ${item.requested} to ${item.applied} before execution`)
    .join("; ")
  return {
    ...result,
    content: [{ type: "text", text: `Cyberful argument adjustment: ${notice}.` }, ...result.content],
    _meta: { ...existingMeta, cyberful: { ...existingCyberful, adjustments } },
  }
}

function annotateBrowserProfile(result: CallToolResult, profile: BrowserProfileId | undefined): CallToolResult {
  if (profile === undefined) return result
  const existingMeta = isRecord(result._meta) ? result._meta : {}
  const existingCyberful = isRecord(existingMeta.cyberful) ? existingMeta.cyberful : {}
  return {
    ...result,
    _meta: {
      ...existingMeta,
      cyberful: {
        ...existingCyberful,
        browserProfile: profile,
      },
    },
  }
}

export type GatewayServer = Server & { closeGateway: () => Promise<void> }

// ── Variable Expansion Never Returns Secrets To The Model ──────────
// Proxied calls receive the same typed variable expansion as in-process tools,
// including literal preservation for unresolved templates inside document
// content and strict resolution for action arguments. Only the upstream receives
// expanded values. Every textual result is then redacted against all session
// variables before it can re-enter the Expert's context.
// ──────────────────────────────────────────────────────────────
function resolveArgs(sessionID: SessionID, toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const values = new Map(visibleRows(sessionID).map((row) => [row.name, SessionVariable.toInfo(row).value]))
  return SessionVariable.resolveToolArguments(toolName, args, (n) => values.get(n)).args
}

function redactResult(sessionID: SessionID, result: CallToolResult): CallToolResult {
  if (!Array.isArray(result.content)) return result
  const infos = allRows(sessionID).map(SessionVariable.toInfo)
  const content = result.content.map((c) =>
    c.type === "text" ? { ...c, text: SessionVariable.redactText(c.text, infos) } : c,
  )
  return { ...result, content }
}

function resultMetric(result: CallToolResult, name: "lead_count" | "suspected_count" | "confirmed_count") {
  const value = result.content
    ?.flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .match(new RegExp(`^${name}: ([0-9]+)$`, "m"))?.[1]
  if (value === undefined) return undefined
  return Number.parseInt(value, 10)
}

function boundedErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return
  const code = String(value).trim()
  return code && code.length <= 64 && /^[a-zA-Z0-9_.:-]+$/.test(code) ? code : undefined
}

function toolFailureMetadata(result: CallToolResult): Pick<
  ToolUsageEvent,
  "error_class" | "error_code" | "tool_exit_code"
> {
  const text = result.content?.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n") ?? ""
  const records = result.content?.flatMap((content) => {
    if (content.type !== "text") return []
    const parsed = jsonRecord(content.text)
    return parsed ? [parsed] : []
  })
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined
  const candidates = [...(records ?? []), ...(structured ? [structured] : [])]
  const exitValue =
    candidates.map((item) => item.exit_code ?? item.exitCode).find((value) => Number.isInteger(value)) ??
    Number(text.match(/^exit_code:\s*(-?[0-9]+)$/m)?.[1])
  const toolExitCode = Number.isInteger(exitValue) ? Number(exitValue) : undefined
  const timedOut =
    candidates.some((item) => item.timed_out === true || item.timedOut === true) ||
    /^timed_out:\s*true$/m.test(text)
  const errorCode = candidates
    .map((item) => item.error_code ?? item.errorCode ?? item.code)
    .map(boundedErrorCode)
    .find((value) => value !== undefined)
  const invalidArguments = candidates.some((item) => {
    const value = String(item.error_class ?? item.errorClass ?? item.type ?? "").toLowerCase()
    return value.includes("validation") || value.includes("argument")
  })
  return {
    error_class: timedOut
      ? "timeout"
      : toolExitCode !== undefined && toolExitCode !== 0
        ? "nonzero_exit"
        : invalidArguments
          ? "invalid_arguments"
          : "tool_reported_error",
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(toolExitCode !== undefined ? { tool_exit_code: toolExitCode } : {}),
  }
}

function transportFailureMetadata(error: unknown): Pick<ToolUsageEvent, "error_class" | "error_code"> {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  const code =
    typeof error === "object" && error !== null && "code" in error ? boundedErrorCode(error.code) : undefined
  return {
    error_class: message.includes("timeout") || code === "ETIMEDOUT" ? "timeout" : "transport",
    ...(code ? { error_code: code } : {}),
  }
}

async function observeCaptchaCircuit(config: CircuitBreakerConfig, tool: string, result: CallToolResult) {
  if (tool !== "browser_captcha_status" && tool !== "browser_captcha_handoff") return
  const action = browserAction(result)
  if (!action) return
  const scope = { profile: action.profile, origin: action.origin, pageID: action.pageID }
  const value = result.content
    ?.flatMap((content) => {
      if (content.type !== "text") return []
      const parsed = jsonRecord(content.text)
      return parsed ? [parsed] : []
    })
    .find((item) => typeof item.detected === "boolean")
  if (!value) return
  if (value.detected === true) {
    await activateCircuitBreaker(
      config.filePath,
      config.phase,
      scope,
      tool === "browser_captcha_handoff" && !result.isError,
    )
    return
  }
  if (tool === "browser_captcha_status") await clearCircuitBreaker(config.filePath, scope)
}

function browserScope(
  tool: string,
  args: Record<string, unknown>,
  profile: BrowserProfileId | undefined,
  coverage: SurfaceCoverage | undefined,
) {
  if (profile === undefined || !tool.startsWith("browser_")) return
  const current = coverage?.currentScope(profile)
  if (tool !== "browser_navigate" || typeof args.url !== "string") return current
  try {
    const url = new URL(args.url.includes("://") ? args.url : `http://${args.url}`)
    return { profile, origin: url.origin, pageID: current?.pageID ?? "pending" }
  } catch {
    return current
  }
}

function redactResource(sessionID: SessionID, result: ReadResourceResult): ReadResourceResult {
  const infos = allRows(sessionID).map(SessionVariable.toInfo)
  return {
    ...result,
    contents: result.contents.map((content) =>
      "text" in content ? { ...content, text: SessionVariable.redactText(content.text, infos) } : content,
    ),
  }
}

function redactPrompt(sessionID: SessionID, result: GetPromptResult): GetPromptResult {
  const infos = allRows(sessionID).map(SessionVariable.toInfo)
  return {
    ...result,
    messages: result.messages.map((message) => ({
      ...message,
      content:
        message.content.type === "text"
          ? { ...message.content, text: SessionVariable.redactText(message.content.text, infos) }
          : message.content,
    })),
  }
}

function proxyEnabled(): boolean {
  const v = process.env.CYBERFUL_SUBSYSTEM_GATEWAY_PROXY?.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

// ── Profile Choice Avoids Browser Lock Contention ────────────────
// A persistent browser context locks its user-data directory, so another process
// must not launch against a profile with a live CDP holder. The caller performs
// the port probe against Chromium's DevToolsActivePort and allocates the fallback
// before this pure decision. An unlocked pinned profile preserves the human
// login; every other state falls back to a per-run profile whose lock cannot
// collide with another phase or an orphaned browser.
// ─────────────────────────────────────────────────────────────────
export function resolveBrowserUpstreamEnv(input: {
  dedicated?: string
  artifactsDir: string
  livePort?: number
  tempProfileDir: string
}): {
  set: Record<string, string>
  unset: string[]
} {
  if (input.dedicated && !input.livePort) {
    return {
      set: {
        CYBER_BROWSER_USER_DATA_DIR: input.dedicated,
        CYBER_BROWSER_ARTIFACTS_DIR: input.artifactsDir,
      },
      unset: [],
    }
  }
  return {
    set: {
      CYBER_BROWSER_USER_DATA_DIR: input.tempProfileDir,
      CYBER_BROWSER_ARTIFACTS_DIR: path.join(input.tempProfileDir, "artifacts"),
    },
    unset: [],
  }
}

// ── Upstreams Receive Least-Privilege Environments ───────────────
// All built-in processes share the gateway as a parent but do not share the same
// trust boundary. ZAP and Ghidra bridges each receive only their engagement
// credentials; cyberful-os exposes a shell and the browser needs neither.
// Deprecated ZAP scope variables are stripped from every upstream because the
// bridge does not enforce an origin policy. Ledger proof keys remain host-only.
// ─────────────────────────────────────────────────────────────────
export function upstreamProcessEnv(
  key: string,
  inherited: Readonly<Record<string, string | undefined>>,
  configured: Readonly<Record<string, string>> = {},
) {
  const env = Object.fromEntries(
    [...Object.entries(inherited), ...Object.entries(configured)].filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.CYBERFUL_CODE_GRAPH_LEDGER_KEY
  delete env.CYBER_ZAP_SCOPE_PROMPT
  delete env.CYBER_ZAP_ALLOWED_ORIGINS
  if (key !== "zap") {
    delete env.CYBER_ZAP_API_KEY
    delete env.CYBER_ZAP_MCP_KEY
  }
  if (key !== "ghidra") delete env.CYBER_GHIDRA_MCP_KEY
  return env
}

// ── Upstream Availability Follows Workflow Capability Policy ──────
// The gateway connects only the built-in runtimes granted to the active workflow and
// phase. Their clients remain owned here because tools, resources, templates,
// and prompts all share the same transport lifetime. cyberful-os is the required
// execution boundary and fails startup when unavailable; optional browser or
// ZAP and Ghidra failures degrade visibly without inventing a capability that cannot run.
// ──────────────────────────────────────────────────────────────
const BRIEF_BROWSER_TOOLS = new Set([
  "browser_status",
  "browser_navigate",
  "browser_snapshot",
  "browser_captcha_status",
  "browser_captcha_handoff",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_select",
  "browser_set_input_files",
  "browser_scroll",
  "browser_check",
  "browser_press",
  "browser_wait",
  "browser_screenshot",
  "browser_artifact_list",
  "browser_artifact_read",
  "browser_network_log",
  "browser_close",
])

// ── Brief Publishes Preflight Capabilities, Not Research Tools ───
// Brief still needs ordinary browser interaction for login and a local shell
// for attachments and atomic MISSION.md replacement. Publishing a complete
// browser, ZAP, or cyberful-os catalog would also expose replay, scanners, page
// evaluation, and direct request paths before scope is durable. This filter is
// applied to both real and injected upstreams so tests cannot bypass policy.
//
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────
function phaseUpstreamToolAllowed(
  policy: GatewayPhasePolicy,
  capability: SubsystemPhase.WorkflowCapability | undefined,
  name: string,
) {
  if (policy.phase !== "brief") return true
  if (capability === "isolated-exec") return name === "shell"
  if (capability === "browser") return BRIEF_BROWSER_TOOLS.has(name)
  return false
}

async function connectDefaultUpstreams(upstreamDiagnosticSink?: (text: string) => void): Promise<{
  tools: UpstreamTool[]
  clients: Client[]
  close: () => Promise<void>
}> {
  const builtins = SubsystemUpstream.builtin()
  const out: UpstreamTool[] = []
  const clients: Client[] = []
  const ownedProcessRoots = new Set<number>()
  const bridgeContainers = new Set<string>()
  const upstreamCapabilities: readonly {
    readonly key: "cyberful-os" | "browser" | "zap" | "ghidra"
    readonly capability: SubsystemPhase.WorkflowCapability
    readonly browserProfile?: BrowserProfileId
  }[] = [
    { key: "cyberful-os", capability: "isolated-exec" },
    ...BrowserProfile.BROWSER_PROFILE_IDS.map((browserProfile) => ({
      key: "browser" as const,
      capability: "browser" as const,
      browserProfile,
    })),
    { key: "zap", capability: "zap" },
    { key: "ghidra", capability: "ghidra" },
  ]
  const policy = gatewayPhasePolicy()
  for (const { key, capability, browserProfile } of upstreamCapabilities) {
    if (!policy.allows(capability)) continue
    const def = builtins[key]
    if (!def || def.enabled === false || !Array.isArray(def.command) || def.command.length === 0) continue
    let pendingClient: Client | undefined
    let pendingTransport: StdioClientTransport | undefined
    try {
      if ((key === "zap" || key === "ghidra") && "container" in def && def.container)
        bridgeContainers.add(def.container)
      const [cmd, ...args] = def.command
      const env = upstreamProcessEnv(key, process.env, def.environment)
      if (key === "browser" && browserProfile !== undefined) {
        const dedicated = BrowserProfile.browserProfileDir(browserProfile)
        const livePort = await SubsystemBrowserCdp.readCdpPort(dedicated)
        const { set, unset } = resolveBrowserUpstreamEnv({
          dedicated,
          artifactsDir: BrowserProfile.browserArtifactsDir(browserProfile),
          livePort,
          tempProfileDir: path.join(
            os.tmpdir(),
            `expert-browser-${boundSession()}-${process.pid}-profile-${browserProfile}`,
          ),
        })
        for (const [k, v] of Object.entries(set)) env[k] = v
        for (const k of unset) delete env[k]
        env.CYBER_BROWSER_PROFILE_ID = String(browserProfile)
      }
      if (key === "cyberful-os") {
        // ── Container Identity Includes Network Authority ──────────────────
        // AppSec execution derives its container identity from both engagement
        // ownership and the resolved network policy. An offline container can
        // therefore never be reused later with ordinary Docker networking.
        // Live-target workflows retain engagement scope, while phase-owned AppSec containers
        // are registered for removal when their gateway closes.
        // ──────────────────────────────────────────────────────────────
        const workarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim() || process.cwd()
        const workflow = policy.workflow
        const networkAllowed = runtimeNetworkAllowed({
          workflow,
          phase: policy.phase,
          authorized: false,
        })
        const baseContainer =
          process.env.CYBERFUL_OS_CONTAINER?.trim() ||
          SubsystemPhase.expertContainerName(path.resolve(workarea), boundSession())
        const appsecProfile = workflow === "code-audit"
        const container = appsecProfile
          ? `${baseContainer.slice(0, 240)}-${networkAllowed ? "online" : "offline"}`
          : baseContainer
        env.CYBERFUL_OS_WORKSPACE = workarea
        env.CYBERFUL_OS_CONTAINER = container
        env.CYBERFUL_OS_STRICT_PREFLIGHT = "1"
        env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
        const zapProxy = process.env.CYBER_ZAP_PROXY_URL?.trim()
        if (zapProxy) {
          const containerProxy = new URL(zapProxy)
          containerProxy.hostname = "host.docker.internal"
          env.CYBERFUL_OS_HTTP_PROXY = containerProxy.toString()
        }
        const dockerArgs = !networkAllowed
          ? ["--network=none", "--cpus=2", "--memory=4g", "--pids-limit=512", "--security-opt=no-new-privileges"]
          : []
        if (zapProxy) dockerArgs.push("--add-host=host.docker.internal:host-gateway")
        if (workflow && SubsystemPhase.hasCapability(workflow, "evm-lab")) {
          dockerArgs.push(
            ...(zapProxy ? [] : ["--add-host=host.docker.internal:host-gateway"]),
            "--env=HOME=/workspace/.cyberful-evm/cache/home",
            "--env=FOUNDRY_DIR=/workspace/.cyberful-evm/cache/home/.foundry",
            "--env=SVM_HOME=/workspace/.cyberful-evm/cache/home/.svm",
            "--env=XDG_CACHE_HOME=/workspace/.cyberful-evm/cache/home/.cache",
          )
        }
        if (dockerArgs.length > 0) env.CYBERFUL_OS_DOCKER_ARGS = dockerArgs.join(" ")
        process.env.CYBERFUL_OS_CONTAINER = container
        if (appsecProfile) bridgeContainers.add(container)
      }
      pendingTransport = new StdioClientTransport({
        command: cmd,
        args,
        env,
        stderr: upstreamDiagnosticSink ? "pipe" : "inherit",
      })
      if (upstreamDiagnosticSink) {
        pendingTransport.stderr?.on("data", (chunk: Buffer) => {
          try {
            upstreamDiagnosticSink(chunk.toString("utf8"))
          } catch (error) {
            log.warn("upstream diagnostic sink failed", {
              upstream: browserProfile === undefined ? key : `${key}-${browserProfile}`,
              error,
            })
          }
        })
      }
      pendingClient = new Client({ name: "expert-gateway", version: "0.1.0" })
      const client = pendingClient
      await client.connect(pendingTransport)
      if (pendingTransport.pid !== null) ownedProcessRoots.add(pendingTransport.pid)
      clients.push(client)
      const { tools } = await client.listTools()
      for (const t of tools) {
        if (!phaseUpstreamToolAllowed(policy, capability, t.name)) continue
        if (browserProfile === undefined && out.some((u) => u.def.name === t.name)) continue
        out.push({
          def: t,
          capability,
          ...(browserProfile === undefined ? {} : { browserProfile }),
          // ── Tool Calls Share One Explicit Ten-Minute Ceiling ─────────────
          // Authorized scanners can legitimately run beyond the MCP SDK's
          // one-minute default. The gateway and Pi registration therefore
          // share a ten-minute ceiling: long enough for routine full scans, but
          // still finite when an upstream stalls. Both timeout fields match so
          // no hidden outer deadline aborts a call earlier than its policy.
          // ──────────────────────────────────────────────────────────────
          call: async (a) => {
            const result = await client.callTool({ name: t.name, arguments: a }, CallToolResultSchema, {
              timeout: 600_000,
              maxTotalTimeout: 600_000,
            })
            return CallToolResultSchema.parse(result)
          },
        })
      }
    } catch (error) {
      const pendingPID =
        pendingTransport?.pid !== null && pendingTransport?.pid !== undefined ? pendingTransport.pid : undefined
      if (pendingPID !== undefined) ownedProcessRoots.add(pendingPID)
      const captured = pendingPID
        ? await processSnapshot()
            .then((snapshot) => ownedProcessTree(snapshot, [pendingPID]))
            .catch((inventoryError) => {
              log.warn("could not capture partially initialized MCP process tree", {
                upstream: browserProfile === undefined ? key : `${key}-${browserProfile}`,
                error: inventoryError,
              })
              return []
            })
        : []
      const cleanupFailures: unknown[] = []
      await pendingClient?.close().catch((cleanupError) => {
        cleanupFailures.push(cleanupError)
        log.warn("failed to close partially initialized MCP upstream", {
          upstream: browserProfile === undefined ? key : `${key}-${browserProfile}`,
          error: cleanupError,
        })
      })
      const cleanup = await reapCapturedProcessTree(captured, {
        onSurvivors: (processes) =>
          log.warn("partially initialized MCP processes survived SDK close; applying owned-process fallback", {
            upstream: browserProfile === undefined ? key : `${key}-${browserProfile}`,
            processes,
          }),
      }).catch((cleanupError) => {
        cleanupFailures.push(cleanupError)
        return undefined
      })
      if (cleanup?.remaining.length)
        cleanupFailures.push(
          new Error(
            `Partially initialized MCP processes remained: ${cleanup.remaining
              .map((process) => process.pid)
              .join(", ")}`,
          ),
        )
      if (key === "cyberful-os") {
        if (cleanupFailures.length === 0) throw error
        throw new AggregateError([error, ...cleanupFailures], "required MCP upstream failed startup and cleanup")
      }
      log.warn("optional phase gateway upstream is unavailable", {
        upstream: browserProfile === undefined ? key : `${key}-${browserProfile}`,
        error,
        ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}),
      })
    }
  }
  return {
    tools: out,
    clients,
    close: async () => {
      const captured = await processSnapshot()
        .then((snapshot) => ownedProcessTree(snapshot, [...ownedProcessRoots]))
        .catch((error) => {
          log.warn("could not capture owned MCP process baseline before shutdown", { error })
          return []
        })
      const operations = [
        ...clients.map((client) => () => client.close()),
        ...Array.from(bridgeContainers).map((container) => async () => {
          const proc = Bun.spawn(["docker", "rm", "--force", container], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
            timeout: DOCKER_CLEANUP_TIMEOUT_MS,
            maxBuffer: DOCKER_CLEANUP_OUTPUT_BYTES,
          })
          const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
          if (exitCode !== 0 && !stderr.includes("No such container"))
            throw new Error(
              `could not remove managed gateway container ${container} (exit ${exitCode}): ${stderr.trim()}`,
            )
        }),
      ]
      const outcomes = await Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation)))
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      )
      const cleanup = await reapCapturedProcessTree(captured, {
        onSurvivors: (processes) =>
          log.warn("MCP processes survived SDK close; applying owned-process fallback", {
            processes,
          }),
      }).catch((error) => {
        failures.push(error)
        return undefined
      })
      if (cleanup?.remaining.length)
        failures.push(
          new Error(
            `Phase gateway could not reap owned MCP processes: ${cleanup.remaining.map((process) => process.pid).join(", ")}`,
          ),
        )
      if (failures.length > 0)
        throw new AggregateError(failures, "one or more phase gateway upstreams failed to close")
    },
  }
}

export async function createGatewayServer(opts?: {
  upstreams?: UpstreamTool[]
  upstreamClients?: Client[]
  closeUpstreams?: () => Promise<void>
  upstreamDiagnosticSink?: (text: string) => void
}): Promise<GatewayServer> {
  const connected = opts?.upstreams
    ? {
        tools: opts.upstreams,
        clients: opts.upstreamClients ?? [],
        close: opts.closeUpstreams ?? (() => Promise.resolve()),
      }
    : proxyEnabled()
      ? await connectDefaultUpstreams(opts?.upstreamDiagnosticSink)
      : { tools: [], clients: [], close: () => Promise.resolve() }
  const policy = gatewayPhasePolicy()
  const upstreams = connected.tools.filter((upstream) =>
    phaseUpstreamToolAllowed(policy, upstream.capability, upstream.def.name),
  )
  const byName = new Map<string, UpstreamTool[]>()
  for (const upstream of upstreams) {
    const candidates = byName.get(upstream.def.name) ?? []
    candidates.push(upstream)
    byName.set(upstream.def.name, candidates)
  }
  const upstreamDefinitions = Array.from(byName.values(), (candidates) => {
    const definition = candidates[0]?.def
    if (!definition) throw new Error("gateway upstream group has no tool definition")
    const profiles = candidates.flatMap((candidate) =>
      candidate.browserProfile === undefined ? [] : [candidate.browserProfile],
    )
    return profiles.length > 0 ? browserProfileToolDefinition(definition, profiles) : definition
  })
  const phase = policy.phase
  const liveTargetResearch = policy.liveTargetResearch
  const workareaRoot = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  const testObjects = liveTargetResearch ? testObjectLifecycleFromEnvironment() : undefined
  const liveTargetTools = {
    testObjects: testObjects !== undefined,
    egress: liveTargetResearch,
    hypothesis: Boolean(workareaRoot && phase && (policy.hypothesisResearch || policy.hypothesisReadOnly)),
    engagementPolicy: Boolean(
      workareaRoot &&
        phase === "brief" &&
        (policy.workflow === "pentest" || policy.workflow === "bug-bounty"),
    ),
  }
  const localTools = localToolDefinitions(policy, liveTargetTools)
  const codeGraph = localTools.some((tool) => isCodeGraphTool(tool.name)) ? createCodeGraphToolHandler() : undefined
  const handoff = handoffConfig()
  const question = questionEnabled()
  const circuit = circuitBreakerConfig()
  const usage = new ToolUsageRecorder()
  const coverage = workareaRoot && phase ? new SurfaceCoverage(workareaRoot, phase) : undefined
  let enforcedEngagementPolicy = workareaRoot ? await readEngagementPolicy(workareaRoot) : undefined
  const hypotheses =
    workareaRoot && phase && policy.workflow && (policy.hypothesisResearch || policy.hypothesisReadOnly)
      ? new HypothesisRegistry({
          workarea: workareaRoot,
          workflow: policy.workflow,
          phase,
          readOnly: policy.hypothesisReadOnly,
          synthesisRequired: SubsystemNovelty.parseEnvironment()?.required === true,
        })
      : undefined
  const engagementPolicy =
    workareaRoot && liveTargetTools.engagementPolicy ? new EngagementPolicyStore(workareaRoot) : undefined
  let engagementPolicySetThisPhase = false
  const ghidraEvidence =
    workareaRoot && phase && policy.allows("ghidra") ? new GhidraEvidenceRecorder(workareaRoot, phase) : undefined
  const server = new Server(
    { name: "expert-gateway", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  let closing: Promise<void> | undefined

  // ── Gateway Close Owns Every Upstream Resource ────────────────
  // Upstream MCP processes are not guaranteed to share the owning Cyberful
  // process group, so the CLI reaper cannot prove their shutdown. The gateway closes
  // every client, usage journal, and code-graph handler itself. One memoized
  // cleanup promise makes transport close, stdin EOF, signals, and explicit host
  // shutdown idempotent while preserving aggregated cleanup failures.
  // ─────────────────────────────────────────────────────────────
  const closeUpstreams = () =>
    (closing ??= settleOperations("one or more phase gateway resources failed to close", [
      async () => {
        const failures: unknown[] = []
        try {
          await connected.close()
        } catch (error) {
          failures.push(error)
        }
        try {
          await cleanupAuditLabs()
        } catch (error) {
          failures.push(error)
        }
        if (failures.length > 0) throw new AggregateError(failures, "phase runtime and audit lab cleanup failed")
      },
      () => usage.close(),
      ...(coverage ? [() => coverage.close()] : []),
      ...(hypotheses ? [() => hypotheses.close()] : []),
      ...(ghidraEvidence ? [() => ghidraEvidence.close()] : []),
      ...(codeGraph ? [() => codeGraph.close()] : []),
    ]))
  server.onclose = async () => {
    await closeUpstreams().catch((error) => log.error("phase gateway cleanup failed", { error }))
  }

  const tools = new GatewayToolRegistry()
  tools.register(VARIABLE_TOOL_DEF, (args, { sessionID }) => handleVariable(sessionID, args))
  if (question) tools.register(QUESTION_TOOL_DEF, (args) => handleQuestion(server, circuit, args))
  if (handoff)
    tools.register(handoffToolDef(handoff), async (args) => {
      const breakerError = circuit ? await circuitBreakerError(circuit.filePath, "handoff") : undefined
      if (breakerError) return text({ error: breakerError }, true)
      if (!handoff.successor && codeGraph) {
        try {
          // Terminal SARIF and evidence are rendered from the validated ledger,
          // never from a model-selected path or hand-authored structured file.
          await codeGraph.handle("code_finding", { action: "export" })
        } catch (error) {
          return text(
            { error: `terminal finding export failed: ${error instanceof Error ? error.message : String(error)}` },
            true,
          )
        }
      }
      return handleHandoff(handoff, args, {
        testObjects,
        hypotheses,
        coverage,
        engagementPolicy:
          engagementPolicy && !engagementPolicySetThisPhase ? undefined : enforcedEngagementPolicy,
        engagementPolicyRequired: engagementPolicy !== undefined,
      })
    })

  for (const definition of localTools) {
    const name = definition.name
    if (name === SOURCE_IMPORT_TOOL_DEF.name) {
      tools.register(definition, async (args) => {
        try {
          return text(
            await handleSourceImport(args, {
              confirm: (request) => confirmSourceImport(server, question, circuit, request),
            }),
          )
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (isSourceTool(name)) {
      tools.register(definition, async (args) => {
        try {
          return text(await handleSourceTool(name, args))
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (isCodeGraphTool(name) && codeGraph) {
      tools.register(definition, async (args) => {
        try {
          return text(await codeGraph.handle(name, args))
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (isGitTool(name)) {
      tools.register(definition, async (args, { sessionID }) => {
        try {
          return text(await handleGitTool(sessionID, name, args))
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === AUDIT_LAB_TOOL_DEF.name) {
      tools.register(definition, async (args) => {
        try {
          return text(await prepareAuditLab(args))
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === EVM_LAB_TOOL_DEF.name) {
      tools.register(definition, async (args, { sessionID }) => {
        try {
          const resolved = resolveArgs(sessionID, name, args)
          const registry = evmVariableRegistryName(process.env.CYBERFUL_EVM_RUNTIME_ID ?? "")
          const updateRegistry = (variableName: string, present: boolean) => {
            const existing = getVar(sessionID, registry)?.value
            const current = Array.isArray(existing)
              ? existing.filter((value): value is string => typeof value === "string")
              : []
            const names = present
              ? [...new Set([...current, variableName])]
              : current.filter((candidate) => candidate !== variableName)
            if (names.length === 0) deleteVar(sessionID, registry)
            else
              setVar(
                sessionID,
                registry,
                SessionVariable.decodeValue(names),
                "Host-owned EVM variable cleanup registry",
              )
          }
          return text(
            await handleEvmLab(resolved, {
              setVariable: (variableName, value, description) => {
                setVar(
                  sessionID,
                  SessionVariable.Name.make(variableName),
                  SessionVariable.decodeValue(value),
                  description,
                )
                updateRegistry(variableName, true)
              },
              deleteVariable: (variableName) => {
                deleteVar(sessionID, variableName)
                updateRegistry(variableName, false)
              },
            }),
          )
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === EVM_EVIDENCE_TOOL_DEF.name) {
      tools.register(definition, async (args) => {
        try {
          return text(await handleEvmEvidence(args))
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === TEST_OBJECT_TOOL_DEF.name && testObjects) {
      tools.register(definition, async (args) => {
        try {
          if (args.action === "list") return text({ objects: await testObjects.list() })
          if (args.action !== "transition")
            return text({ error: "test_object action must be transition or list" }, true)
          return text({ ok: true, object: await testObjects.transition(args) })
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === HYPOTHESIS_TOOL_DEF.name && hypotheses) {
      tools.register(definition, async (args) => {
        try {
          return text(await hypotheses.handle(args))
        } catch (error) {
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === ENGAGEMENT_POLICY_TOOL_DEF.name && engagementPolicy) {
      tools.register(definition, async (args) => {
        try {
          if (args.action === "get") return text((await engagementPolicy.get()) ?? { configured: false })
          const policyResult = engagementPolicy.prepare(args)
          const proxyUrl = process.env.CYBER_ZAP_PROXY_URL?.trim()
          const apiKey = process.env.CYBER_ZAP_API_KEY?.trim()
          if (!proxyUrl || !apiKey)
            return text({ error: "engagement HTTP policy requires an active ZAP runtime" }, true)
          const enforcement = await applyEngagementRateLimit(policyResult as EngagementPolicy, { proxyUrl, apiKey })
          await engagementPolicy.commit(policyResult)
          enforcedEngagementPolicy = policyResult
          engagementPolicySetThisPhase = true
          return text({ policy: policyResult, enforcement })
        } catch (error) {
          if (error instanceof ZapRateLimitInstallError) return text(error.toolResult(), true)
          return text({ error: error instanceof Error ? error.message : String(error) }, true)
        }
      })
      continue
    }
    if (name === EGRESS_OBSERVATION_TOOL_DEF.name) {
      tools.register(definition, async (args) => {
        try {
          const observation = EgressObservation.declared(args)
          await usage.record({ tool: name, outcome: "ok", egress_blocked: false, ...observation })
          return text({ ok: true, observation })
        } catch (error) {
          log.warn("egress observation degraded", { error })
          return text({ ok: false, observability: "degraded", output: "Network execution remains unaffected." })
        }
      })
      continue
    }
    throw new Error(`gateway tool '${name}' has no local dispatcher`)
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.definitions(), ...upstreamDefinitions],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const sessionID = boundSession()
    const name = req.params.name
    const args = req.params.arguments ?? {}
    const local = tools.call(name, args, { sessionID })
    if (local) {
      const result = await local
      return result
    }
    const candidates = byName.get(name)
    if (!candidates) return text({ error: `unknown tool ${name}` })
    const resolvedArgs = resolveArgs(sessionID, name, args)
    let selected: ReturnType<typeof selectBrowserProfileUpstream>
    try {
      selected = selectBrowserProfileUpstream(candidates, resolvedArgs)
    } catch (error) {
      return text({ error: error instanceof Error ? error.message : String(error) }, true)
    }
    const breakerError = circuit
      ? await circuitBreakerError(
          circuit.filePath,
          name,
          browserScope(name, selected.args, selected.upstream.browserProfile, coverage),
        )
      : undefined
    if (breakerError) return text({ error: breakerError }, true)
    const upstream = selected.upstream
    const adjusted = adjustUpstreamArguments(upstream.def, selected.args)
    const startedAt = performance.now()
    try {
      const result = annotateBrowserProfile(
        annotateAdjustments(await upstream.call(adjusted.args), adjusted.adjustments),
        upstream.browserProfile,
      )
      if (circuit) await observeCaptchaCircuit(circuit, name, result)
      let redacted = redactResult(sessionID, result)
      if (upstream.capability === "ghidra" && ghidraEvidence) {
        try {
          const evidence = await ghidraEvidence.record(name, args, redacted)
          redacted = {
            ...redacted,
            content: [
              ...redacted.content,
              { type: "text", text: `Ghidra evidence: ${evidence.path} (sha256 ${evidence.sha256})` },
            ],
          }
        } catch (error) {
          log.warn("could not persist Ghidra workarea evidence", { tool: name, error })
          redacted = {
            ...redacted,
            content: [
              ...redacted.content,
              { type: "text", text: `Ghidra evidence capture failed: ${errorMessage(error)}` },
            ],
          }
        }
      }
      const egress = EgressObservation.observe(name, resolvedArgs, result)
      await coverage?.observe(result, egress)
      await usage
        .record({
          tool: name,
          duration_ms: Math.round(performance.now() - startedAt),
          outcome: redacted.isError ? "error" : "ok",
          bytes_out: Buffer.byteLength(JSON.stringify(redacted)),
          marker_attested: undefined,
          lead_count: resultMetric(redacted, "lead_count"),
          suspected_count: resultMetric(redacted, "suspected_count"),
          confirmed_count: resultMetric(redacted, "confirmed_count"),
          ...(redacted.isError ? toolFailureMetadata(redacted) : {}),
          ...(upstream.browserProfile !== undefined ? { browser_profile: upstream.browserProfile } : {}),
          ...(egress ? { egress_blocked: false, ...egress } : {}),
        })
        .catch((error) => log.warn("could not record completed phase tool call", { tool: name, error }))
      return redacted
    } catch (error) {
      const egress = EgressObservation.observe(name, resolvedArgs, { content: [] })
      await usage
        .record({
          tool: name,
          duration_ms: Math.round(performance.now() - startedAt),
          outcome: "error",
          ...transportFailureMetadata(error),
          ...(upstream.browserProfile !== undefined ? { browser_profile: upstream.browserProfile } : {}),
          ...(egress ? { egress_blocked: false, ...egress } : {}),
        })
        .catch((auditError) => log.warn("could not record failed phase tool call", { tool: name, error: auditError }))
      throw error
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const pages = await collectUpstreamLists("resources", connected.clients, async (client) => {
      const resources = []
      let cursor: string | undefined
      do {
        const page = await client.listResources(cursor ? { cursor } : undefined)
        resources.push(...page.resources)
        cursor = page.nextCursor
      } while (cursor)
      return resources
    })
    return {
      resources: pages
        .flat()
        .filter((resource, index, all) => all.findIndex((item) => item.uri === resource.uri) === index),
    }
  })

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const pages = await collectUpstreamLists("resource templates", connected.clients, async (client) => {
      const resourceTemplates = []
      let cursor: string | undefined
      do {
        const page = await client.listResourceTemplates(cursor ? { cursor } : undefined)
        resourceTemplates.push(...page.resourceTemplates)
        cursor = page.nextCursor
      } while (cursor)
      return resourceTemplates
    })
    return {
      resourceTemplates: pages
        .flat()
        .filter((resource, index, all) => all.findIndex((item) => item.uriTemplate === resource.uriTemplate) === index),
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const failures: unknown[] = []
    for (const client of connected.clients) {
      try {
        return redactResource(boundSession(), await client.readResource(req.params))
      } catch (error) {
        failures.push(error)
      }
    }
    throw new AggregateError(failures, `unknown or unavailable upstream resource ${req.params.uri}`)
  })

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const pages = await collectUpstreamLists("prompts", connected.clients, async (client) => {
      const prompts = []
      let cursor: string | undefined
      do {
        const page = await client.listPrompts(cursor ? { cursor } : undefined)
        prompts.push(...page.prompts)
        cursor = page.nextCursor
      } while (cursor)
      return prompts
    })
    return {
      prompts: pages
        .flat()
        .filter((prompt, index, all) => all.findIndex((item) => item.name === prompt.name) === index),
    }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const sessionID = boundSession()
    const resolved = resolveArgs(sessionID, `prompt:${req.params.name}`, req.params.arguments ?? {})
    const promptArguments: Record<string, string> = {}
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value !== "string") throw new Error(`prompt ${req.params.name} arguments must resolve to strings`)
      promptArguments[key] = value
    }
    const params = { ...req.params, arguments: promptArguments }
    const failures: unknown[] = []
    for (const client of connected.clients) {
      try {
        return redactPrompt(sessionID, await client.getPrompt(params))
      } catch (error) {
        failures.push(error)
      }
    }
    throw new AggregateError(failures, `unknown or unavailable upstream prompt ${req.params.name}`)
  })

  return Object.assign(server, {
    closeGateway: async () => {
      await server.close()
      await closeUpstreams()
    },
  })
}

// ── One Root PID Owns An Inherited Gateway Family ─────────────────
// The host must identify the root gateway even when an upstream fails during
// startup or the in-process Pi owner closes the MCP server directly. Delegated
// AgentRuns inherit the same MCP registration and therefore start sibling
// gateway processes with the same signal path. The first process claims that
// path exclusively; later gateways accept only its validated marker and never
// replace it, so phase teardown retains one stable lifecycle root. The host's
// teardown path, rather than a sandbox-sensitive cross-process signal probe,
// owns liveness checks.
// ───────────────────────────────────────────────────────────────
export async function writeGatewayPidSignal(signalPath: string, pid = process.pid): Promise<void> {
  if (!path.isAbsolute(signalPath)) throw new Error("expert-gateway PID signal path must be absolute")
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("expert-gateway PID must identify a real process")
  await writeFile(signalPath, JSON.stringify({ pid }), { flag: "wx" })
}

export async function claimGatewayPidSignal(
  signalPath: string,
  pid = process.pid,
): Promise<{ owner: boolean; pid: number }> {
  try {
    await writeGatewayPidSignal(signalPath, pid)
    return { owner: true, pid }
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error
  }
  let owner: unknown
  try {
    owner = JSON.parse(await readFile(signalPath, "utf8"))
  } catch (error) {
    throw new Error("expert-gateway PID signal is unreadable", { cause: error })
  }
  if (!isRecord(owner) || !Number.isInteger(owner.pid) || Number(owner.pid) <= 1)
    throw new Error("expert-gateway PID signal does not identify its root owner")
  const ownerPID = Number(owner.pid)
  return { owner: false, pid: ownerPID }
}

export function parentUnavailable(originalParentPID: number, currentParentPID = process.ppid): boolean {
  if (currentParentPID !== originalParentPID) return true
  try {
    process.kill(originalParentPID, 0)
    return false
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return true
    if (nodeErrorCode(error) === "EPERM") return false
    throw error
  }
}

// ── Gateway Main Owns Orphan Detection And Shutdown ─────────────
// The gateway runs over stdio but the SDK does not close its upstream children
// when that input pipe ends. EOF, host signals, and a changed or dead owning
// Cyberful process therefore converge on one idempotent shutdown promise.
// Parent polling is only a backstop for runtimes that fail to deliver EOF.
// Keeping this wiring out of module initialization lets tests use in-memory
// transports safely.
// ─────────────────────────────────────────────────────────────
export async function runGatewayMain() {
  await loadPrivateGatewayEnvironment()
  const pidSignalPath = process.env.CYBERFUL_SUBSYSTEM_GATEWAY_PID_PATH?.trim()
  if (pidSignalPath) await claimGatewayPidSignal(pidSignalPath)
  const server = await createGatewayServer()
  await server.connect(new StdioServerTransport())
  const parentPID = process.ppid
  let parentWatch: ReturnType<typeof setInterval> | undefined
  let shutdown: Promise<void> | undefined
  const stop = () => {
    if (shutdown) return
    if (parentWatch) clearInterval(parentWatch)
    shutdown = (async () => {
      try {
        await server.closeGateway()
        process.exit(0)
      } catch (error) {
        log.error("phase gateway shutdown failed", { error })
        process.exit(1)
      }
    })()
  }
  process.stdin.once("end", stop)
  process.stdin.once("close", stop)
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  parentWatch = setInterval(() => {
    if (parentUnavailable(parentPID)) stop()
  }, 1000)
  parentWatch.unref()
}

if (import.meta.main) {
  await runGatewayMain()
}
