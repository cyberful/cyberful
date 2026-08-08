// ── Session Prompt Runtime ───────────────────────────────────────
// Journals user input and runs or steers the Pi engagement selected
//   for a session through completion.
// → cyberful/src/subsystem/orchestrator.ts — advances workflow phases.
// → cyberful/src/subsystem/engagement-runtime.ts — owns the unified tooling container.
// → cyberful/src/subsystem/container.ts — proves disposable session resources are absent.
// → cyberful/src/util/bounded-output.ts — bounds retained user shell output.
// ─────────────────────────────────────────────────────────────────

import os from "os"
import path from "path"
import { copyFile, lstat, mkdir, readFile } from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import piAgentPackage from "@earendil-works/pi-agent-core/package.json"
import { CrossSpawnSpawner } from "@/effect/cross-spawn-spawner"
import * as Log from "@/util/log"
import * as EffectLogger from "@/effect/logger"
import { AppFileSystem } from "@/effect/filesystem"
import { FileAttachment, ReferenceAttachment, Source } from "@/session/prompt-v2"
import { NamedError } from "@/util/error"
import { Cause, Context, Effect, Exit, Latch, Layer, Option, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import * as Stream from "effect/Stream"
import { ulid } from "ulid"
import { Command } from "../command"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { DependencyConfig } from "@/dependency/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Event } from "@/event"
import { SubsystemControl } from "@/subsystem/control"
import { SubsystemContainer } from "@/subsystem/container"
import { SubsystemCompletion } from "@/subsystem/completion"
import { SubsystemAskRuntime } from "@/subsystem/ask-runtime"
import { SubsystemOrchestrator } from "@/subsystem/orchestrator"
import { SubsystemPhase } from "@/subsystem/phase"
import { SubsystemPhaseRunner } from "@/subsystem/phase-runner"
import { SubsystemRunStateArtifact } from "@/subsystem/run-state-artifact"
import type { PhaseActivityActor, PhaseActivityActorState, PhaseActivityArtifact } from "@/subsystem/subsystem"
import { SubsystemUsage } from "@/subsystem/usage"
import { RuntimeDiagnosticRecorder } from "@/subsystem/runtime-diagnostics"
import { SubsystemVerdict } from "@/subsystem/verdict"
import { SubsystemEvmRuntime } from "@/subsystem/evm/runtime"
import { SubsystemEngagementRuntime } from "@/subsystem/engagement-runtime"
import { HostGhidraStore } from "@/ghidra-store"
import { HostSourceStore } from "@/source-store"
import { Question } from "@/question"
import { Reference } from "@/reference/reference"
import { ModelID, SubsystemID } from "@/subsystem/identity"
import { Shell } from "@/shell/shell"
import { ShellID } from "@/tool/shell/id"
import {
  renderMarkdownReportToPdf,
  renderReportToPdf,
  stripUnresolvedTemplates,
  type ReportMeta,
} from "@/tool/security-report-pdf"
import { errorMessage } from "@/util/error"
import { Process } from "@/util/process"
import { ensureWorkarea, ensureWorkareaDirectory, replaceWorkareaFile, workareaAbsolutePath } from "@/workarea"
import { SessionEvent } from "@/session/event"
import { EngagementStatus } from "./engagement-status"
import { MessageV2 } from "./message-v2"
import { referencePromptMetadata, referenceTextPart } from "./prompt/reference"
import { SessionRevert } from "./revert"
import { SessionRunState } from "./run-state"
import { MessageID, PartID, SessionID } from "./schema"
import * as Session from "./session"
import { SessionPhaseEpoch } from "./phase-epoch"
import { SessionStatus } from "./status"
import { SessionReportLog } from "./report-log"
import { SessionVariable } from "./variable"
import { SessionCompletion } from "./completion"
import { SessionAskContext } from "./ask-context"
import { SessionRuntimeCompatibility } from "./runtime-compatibility"
import { FindingRegistry } from "@/finding/registry"
import { SessionFinding } from "./finding"
import { SessionHypothesis } from "./hypothesis"
import { readHypothesisRegistryView } from "@/subsystem/gateway/hypothesis-registry"
import { createCodeGraphService } from "@/code-graph/service"
import { findingHandoffWarning, findingWorkflow } from "./finding-handoff"
import type { CommandInput, LoopInput, PromptInput, ShellInput } from "./prompt-input"
import { carryEngagementStatus, steerHeadFields } from "./prompt-policy"
import { ATTACHMENT_TEXT_LIMIT, attachmentText, objectiveFromMessage, textMime } from "./prompt-content"
import { createShellOutputTail, renderShellOutput } from "./shell-output"

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })
const decodeMessageInfo = Schema.decodeUnknownExit(MessageV2.Info)
const decodeMessagePart = Schema.decodeUnknownExit(MessageV2.Part)
const FINDING_WRITE_PHASES = new Set(["recon", "exploit", "hacker", "verify"])
const PI_RUNTIME_DESCRIPTOR = {
  name: "pi",
  version: piAgentPackage.version,
  label: `Pi Agent v${piAgentPackage.version}`,
}

async function lstatIfPresent(target: string) {
  try {
    return await lstat(target)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

// ── A Journal Identity, Not A Subsystem Choice ─────────────────────
// Session rows require a model-shaped identity. Every writer in this module
// stamps the immutable Pi marker, so no request field can select a provider,
// subsystem, variant, or reasoning policy for inference.
// The marker identifies journal provenance only; execution policy remains host-owned.
// ──────────────────────────────────────────────────────────────────

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
  readonly steer: (input: {
    sessionID: SessionID
    parts: PromptInput["parts"]
    expectedEpoch?: SessionPhaseEpoch.Identity
  }) => Effect.Effect<boolean>
  readonly loop: (input: LoopInput) => Effect.Effect<MessageV2.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
}

type PromptInputInternal = PromptInput & {
  metadata?: Record<string, unknown>
  deliveryGuard?: (message: MessageV2.WithParts) => Effect.Effect<boolean>
  appendGuard?: Effect.Effect<boolean>
}

type JournalInputPart = MessageV2.TextPart | MessageV2.FilePart

export class Service extends Context.Service<Service, Interface>()("@cyberful/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const events = yield* Event.Service
    const flags = yield* RuntimeFlags.Service
    const fsys = yield* AppFileSystem.Service
    const question = yield* Question.Service
    const references = yield* Reference.Service
    const revert = yield* SessionRevert.Service
    const sessions = yield* Session.Service
    const state = yield* SessionRunState.Service
    const status = yield* SessionStatus.Service
    const variables = yield* SessionVariable.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const legacyRuntimeError = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const error = new NamedError.Unknown({
          message:
            "This active session was created by the legacy Codex runtime and cannot be resumed with Pi Agent. Start a new session; completed reports, transcripts, and workarea artifacts remain available.",
        })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      })
    const runtimeHistory = (sessionID: SessionID) =>
      sessions.messages({ sessionID }).pipe(
        Effect.orDie,
        Effect.map((messages) => SessionRuntimeCompatibility.classify(messages)),
      )
    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      yield* state.cancel(sessionID)
    })

    // ── Mentions Resolve To Data, Never To Delegation ────────────────
    // @reference and @path syntax remains useful for building an AgentRun
    // objective. A missing path stays ordinary text; it is never converted
    // into an AgentPart or a task-tool request.
    // This keeps textual context separate from the runtime delegation boundary.
    // ──────────────────────────────────────────────────────────────────

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Array<PromptInput["parts"][number]> = [{ type: "text", text: template }]
      const seen = new Set<string>()
      yield* Effect.forEach(
        ConfigMarkdown.files(template),
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name || seen.has(name)) return
          seen.add(name)
          const source = {
            value: match[0],
            start: match.index ?? 0,
            end: (match.index ?? 0) + match[0].length,
          }
          const slash = name.indexOf("/")
          const alias = slash === -1 ? name : name.slice(0, slash)
          const reference = yield* references.get(alias)
          if (reference) {
            if (reference.kind === "invalid") {
              parts.push(
                referenceTextPart({ reference, source, target: slash === -1 ? undefined : name.slice(slash + 1) }),
              )
              return
            }
            yield* references.ensure(reference.path)
            if (slash === -1) {
              parts.push(referenceTextPart({ reference, source }))
              return
            }
            const target = name.slice(slash + 1)
            const targetPath = path.resolve(reference.path, target)
            if (!AppFileSystem.contains(reference.path, targetPath)) {
              parts.push(
                referenceTextPart({
                  reference,
                  source,
                  target,
                  targetPath,
                  problem: `Path escapes configured reference @${alias}: ${target}`,
                }),
              )
              return
            }
            const info = yield* fsys.stat(targetPath).pipe(Effect.option)
            if (Option.isNone(info)) {
              parts.push(
                referenceTextPart({
                  reference,
                  source,
                  target,
                  targetPath,
                  problem: `Path does not exist inside configured reference @${alias}: ${target}`,
                }),
              )
              return
            }
            parts.push({
              type: "file",
              url: pathToFileURL(targetPath).href,
              filename: name,
              mime: info.value.type === "Directory" ? "application/x-directory" : "text/plain",
              source: { type: "file", path: targetPath, text: source },
            })
            return
          }

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)
          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) return
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: info.value.type === "Directory" ? "application/x-directory" : "text/plain",
            source: { type: "file", path: filepath, text: source },
          })
        }),
        { concurrency: 8, discard: true },
      )
      return parts
    })

    const currentPhase = Effect.fn("SessionPrompt.currentPhase")(function* (sessionID: SessionID, requested?: string) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const completion = yield* sessions
        .findMessage(sessionID, (message) =>
          message.parts.some((part) => part.type === "completion" && part.nextWorkflow),
        )
        .pipe(Effect.orDie)
      const nextWorkflow = Option.isSome(completion)
        ? completion.value.parts.find((part): part is MessageV2.CompletionPart => part.type === "completion")
            ?.nextWorkflow
        : undefined
      if (nextWorkflow && nextWorkflow !== session.workflow) {
        const nextAgent = SubsystemPhase.workflowKickoffPhase(nextWorkflow)
        if (nextAgent) {
          yield* sessions.setWorkflow({ sessionID, workflow: nextWorkflow, agent: nextAgent })
          return nextAgent
        }
      }
      const activeWorkflow = session.workflow ?? (session.agent ? SubsystemPhase.workflowOf(session.agent) : undefined)
      const activeAgent = activeWorkflow ? SubsystemPhase.workflowKickoffPhase(activeWorkflow) : undefined
      if (activeWorkflow && SubsystemPhase.workflow(activeWorkflow)?.kind === "interactive" && activeAgent)
        return activeAgent
      const requestedPhase =
        activeWorkflow && requested ? SubsystemPhase.canonicalPhase(activeWorkflow, requested) : undefined
      if (activeWorkflow && requestedPhase && SubsystemPhase.isExpertPhase(activeWorkflow, requestedPhase))
        return requestedPhase
      if (activeAgent) return activeAgent
      if (!activeWorkflow) {
        const error = new NamedError.Unknown({ message: "A workflow is required to resolve this phase." })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }
      const match = yield* sessions
        .findMessage(
          sessionID,
          (message) => message.info.role === "user" && SubsystemPhase.isExpertPhase(activeWorkflow, message.info.agent),
        )
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user")
        return SubsystemPhase.canonicalPhase(activeWorkflow, match.value.info.agent)
      if (session.agent && SubsystemPhase.isExpertPhase(activeWorkflow, session.agent))
        return SubsystemPhase.canonicalPhase(activeWorkflow, session.agent)
      const error = new NamedError.Unknown({ message: "This build accepts only Pi Agent engagement phases." })
      yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
      throw error
    })

    const attachmentDirectory = Effect.fn("SessionPrompt.attachmentDirectory")(function* (input: PromptInputInternal) {
      const ctx = yield* InstanceState.context
      const selectedWorkarea = input.workarea
      if (selectedWorkarea) {
        const workarea = yield* Effect.promise(() => ensureWorkarea(ctx.directory, selectedWorkarea))
        return yield* Effect.promise(() => ensureWorkareaDirectory(workarea, "inputs"))
      }
      const dir = path.join(ctx.directory, "inputs", input.sessionID)
      yield* Effect.tryPromise({ try: () => mkdir(dir, { recursive: true }), catch: (cause) => cause }).pipe(
        Effect.orDie,
      )
      return dir
    })

    const materializeAttachment = Effect.fn("SessionPrompt.materializeAttachment")(function* (input: {
      prompt: PromptInputInternal
      partID: PartID
      filename?: string
      sourcePath?: string
      bytes?: Uint8Array
    }) {
      const safeName = path.basename(input.filename ?? "attachment").replace(/[^a-zA-Z0-9_.-]/g, "-") || "attachment"
      const selectedWorkarea = input.prompt.workarea
      if (selectedWorkarea) {
        const ctx = yield* InstanceState.context
        const workarea = yield* Effect.promise(() => ensureWorkarea(ctx.directory, selectedWorkarea))
        const sourcePath = input.sourcePath
        const bytes = sourcePath ? yield* Effect.promise(() => readFile(sourcePath)) : (input.bytes ?? new Uint8Array())
        return yield* Effect.promise(() =>
          replaceWorkareaFile(workarea, `inputs/${input.partID}-${safeName}`, bytes, { mode: 0o600 }),
        )
      }
      const target = path.join(yield* attachmentDirectory(input.prompt), `${input.partID}-${safeName}`)
      yield* Effect.tryPromise({
        try: () =>
          input.sourcePath
            ? copyFile(input.sourcePath, target).then(() => {})
            : Bun.write(target, input.bytes ?? new Uint8Array()).then(() => {}),
        catch: (cause) => cause,
      }).pipe(Effect.orDie)
      return target
    })

    const referenceContextFromFilePart = Effect.fn("SessionPrompt.referenceContext")(function* (
      part: Extract<PromptInput["parts"][number], { type: "file" }>,
      filepath: string,
    ) {
      const name = part.filename?.replace(/#\d+(?:-\d*)?$/, "")
      if (!name) return
      const slash = name.indexOf("/")
      if (slash === -1) return
      const reference = yield* references.get(name.slice(0, slash))
      if (!reference || reference.kind === "invalid" || !AppFileSystem.contains(reference.path, filepath)) return
      const target = path.relative(reference.path, filepath).split(path.sep).join("/")
      if (!target || target.startsWith("../") || target === "..") return
      return referenceTextPart({
        reference,
        source: part.source?.text ?? { value: `@${name}`, start: 0, end: name.length + 1 },
        target,
        targetPath: filepath,
      })
    })

    // ── Attachments Cross The Boundary As Files Or Text ──────────────
    // Text is read directly without a subsystem/model lookup. Binary data is
    // copied into the workarea and named in the AgentRun objective, so the phase
    // process can inspect it through its ordinary filesystem tools.
    // No attachment grants a path outside the phase-owned workarea.
    // ──────────────────────────────────────────────────────────────────

    const resolveUserPart = Effect.fn("SessionPrompt.resolveUserPart")(function* (
      input: PromptInputInternal,
      info: MessageV2.User,
      part: PromptInput["parts"][number],
    ) {
      const partID = part.id ? PartID.make(part.id) : PartID.ascending()
      if (part.type === "text")
        return [{ ...part, id: partID, messageID: info.id, sessionID: input.sessionID }] satisfies JournalInputPart[]

      const base = { ...part, id: partID, messageID: info.id, sessionID: input.sessionID }
      const url = new URL(part.url)
      if (url.protocol === "data:") {
        const comma = part.url.indexOf(",")
        const header = comma === -1 ? "" : part.url.slice(0, comma)
        const body = comma === -1 ? "" : part.url.slice(comma + 1)
        const bytes = header.includes(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body))
        if (textMime(part.mime)) {
          return [
            {
              id: PartID.ascending(),
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: attachmentText(part.filename, bytes.toString("utf8")),
            },
            base,
          ] satisfies JournalInputPart[]
        }
        const target = yield* materializeAttachment({ prompt: input, partID, filename: part.filename, bytes })
        return [
          {
            id: PartID.ascending(),
            messageID: info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: `Attachment ${part.filename ?? "file"} is available to the AgentRun at ${target}.`,
          },
          { ...base, url: pathToFileURL(target).href },
        ] satisfies JournalInputPart[]
      }

      if (url.protocol !== "file:") return [base]
      const filepath = fileURLToPath(part.url)
      const reference = yield* referenceContextFromFilePart(part, filepath)
      const referencePart = reference
        ? [{ ...reference, id: PartID.ascending(), messageID: info.id, sessionID: input.sessionID }]
        : []
      if (yield* fsys.isDir(filepath)) {
        const listing = yield* fsys
          .readDirectoryEntries(filepath)
          .pipe(Effect.orDie)
          .pipe(
            Effect.map((entries) =>
              entries
                .slice(0, 1_000)
                .map((entry) => `${entry.type}\t${entry.name}`)
                .join("\n"),
            ),
          )
        return [
          ...referencePart,
          {
            id: PartID.ascending(),
            messageID: info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: `Attached directory ${filepath}:\n${listing}`,
          },
          { ...base, mime: "application/x-directory" },
        ] satisfies JournalInputPart[]
      }
      if (textMime(part.mime)) {
        const text = yield* Effect.tryPromise({
          try: () =>
            Bun.file(filepath)
              .slice(0, ATTACHMENT_TEXT_LIMIT + 1)
              .text(),
          catch: (cause) => cause,
        }).pipe(Effect.orDie)
        return [
          ...referencePart,
          {
            id: PartID.ascending(),
            messageID: info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: attachmentText(filepath, text),
          },
          base,
        ] satisfies JournalInputPart[]
      }
      const target = yield* materializeAttachment({
        prompt: input,
        partID,
        filename: part.filename,
        sourcePath: filepath,
      })
      return [
        ...referencePart,
        {
          id: PartID.ascending(),
          messageID: info.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: `Attachment ${part.filename ?? path.basename(filepath)} is available to the AgentRun at ${target}.`,
        },
        { ...base, url: pathToFileURL(target).href },
      ] satisfies JournalInputPart[]
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInputInternal) {
      if (!SessionRuntimeCompatibility.canAppendPiPrompt(yield* runtimeHistory(input.sessionID)))
        return yield* legacyRuntimeError(input.sessionID)
      const phase = yield* currentPhase(input.sessionID, input.agent)
      const previous = yield* sessions
        .findMessage(input.sessionID, (message) => message.info.role === "user")
        .pipe(Effect.orElseSucceed(() => Option.none<MessageV2.WithParts>()))
      const suppliedMetadata = {
        ...(input.metadata ?? {}),
        ...(input.delivery ? { delivery: input.delivery } : {}),
        ...(input.workarea ? { workarea: input.workarea } : {}),
      }
      const metadata = carryEngagementStatus({
        metadata: suppliedMetadata,
        delivery: input.delivery,
        previousMetadata:
          Option.isSome(previous) && previous.value.info.role === "user" ? previous.value.info.metadata : undefined,
      })
      const configuredMarker = DependencyConfig.expertSessionModel()
      const marker = {
        subsystemID: SubsystemID.make(configuredMarker.subsystemID),
        modelID: ModelID.make(configuredMarker.modelID),
      }
      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: phase,
        model: marker,
        system: input.system,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      }
      const parts: MessageV2.Part[] = (yield* Effect.forEach(
        input.parts,
        (part) =>
          resolveUserPart(input, info, part).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
              const label = part.type === "file" ? (part.filename ?? part.url) : "text input"
              return Effect.succeed([
                {
                  id: PartID.ascending(),
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text" as const,
                  synthetic: true,
                  text: `Unable to prepare attached ${label}: ${errorMessage(Cause.squash(cause))}`,
                },
              ])
            }),
          ),
        { concurrency: 8 },
      )).flat()

      validateJournalMessage(info, parts)
      const message = { info, parts }

      // A live steer becomes conversation history only after Pi acknowledges the exact active AgentRun.
      // This guard deliberately runs outside the journal write permit: handoff must remain free to advance
      // while input submitted in the transition gap waits for the successor to register.
      if (input.deliveryGuard && !(yield* input.deliveryGuard(message))) return

      const appended = yield* sessions.appendMessage({
        info,
        parts,
        guard: Effect.gen(function* () {
          if (!SessionRuntimeCompatibility.canAppendPiPrompt(yield* runtimeHistory(input.sessionID)))
            return yield* legacyRuntimeError(input.sessionID)
          return input.appendGuard ? yield* input.appendGuard : true
        }),
      })
      if (!appended) return

      if (
        flags.experimentalEventSystem &&
        (!Option.isSome(previous) || previous.value.info.role !== "user" || previous.value.info.agent !== phase)
      ) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          agent: phase,
        })
      }

      const eventPrompt = parts.reduce<{
        text: string[]
        files: FileAttachment[]
        references: ReferenceAttachment[]
        synthetic: string[]
      }>(
        (result, part) => {
          if (part.type === "text") {
            if (part.synthetic) result.synthetic.push(part.text)
            else result.text.push(part.text)
            const reference = referencePromptMetadata(part.metadata?.reference)
            if (reference)
              result.references.push(
                new ReferenceAttachment({
                  name: reference.name,
                  kind: reference.kind,
                  uri: reference.path ? pathToFileURL(reference.path).href : undefined,
                  repository: reference.repository,
                  branch: reference.branch,
                  target: reference.target,
                  targetUri: reference.targetPath ? pathToFileURL(reference.targetPath).href : undefined,
                  problem: reference.problem,
                  source: new Source({
                    start: reference.source.start,
                    end: reference.source.end,
                    text: reference.source.value,
                  }),
                }),
              )
          }
          if (part.type === "file")
            result.files.push(
              new FileAttachment({
                uri: part.url,
                mime: part.mime,
                name: part.filename,
                source: part.source
                  ? new Source({
                      start: part.source.text.start,
                      end: part.source.text.end,
                      text: part.source.text.value,
                    })
                  : undefined,
              }),
            )
          return result
        },
        {
          text: [],
          files: [],
          references: [],
          synthetic: [],
        },
      )
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(info.time.created),
          prompt: {
            text: eventPrompt.text.join("\n"),
            files: eventPrompt.files,
            references: eventPrompt.references,
          },
        })
      }
      if (flags.experimentalEventSystem) {
        yield* Effect.forEach(
          eventPrompt.synthetic,
          (text) =>
            events.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              timestamp: DateTime.makeUnsafe(info.time.created),
              text,
            }),
          { discard: true },
        )
      }
      return message
    })

    const submitPrompt = Effect.fn("SessionPrompt.submitPrompt")(function* (input: PromptInputInternal) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const busy = yield* state.isBusy(input.sessionID)
      const delivery = input.delivery === "deferred" && busy ? "deferred" : "immediate"
      const message = yield* createUserMessage({
        ...input,
        delivery: busy ? delivery : undefined,
        deliveryGuard:
          busy && delivery === "immediate"
            ? (candidate) =>
                Effect.promise(() =>
                  SubsystemControl.steer({
                    sessionID: input.sessionID,
                    text: objectiveFromMessage(candidate),
                  }).then((acknowledgement) => acknowledgement.accepted),
                )
            : undefined,
      })
      if (!message) return
      yield* sessions.touch(input.sessionID)

      if (busy && delivery === "immediate") return message
      if (input.noReply === true || delivery === "deferred") return message
      return yield* loop({ sessionID: input.sessionID })
    })

    const prompt: Interface["prompt"] = (input) =>
      submitPrompt(input).pipe(
        Effect.map((message) => {
          if (!message) throw new Error("The active AgentRun did not acknowledge the message")
          return message
        }),
      )

    const lastAssistant = Effect.fn("SessionPrompt.lastAssistant")(function* (sessionID: SessionID) {
      const match = yield* sessions
        .findMessage(sessionID, (message) => message.info.role === "assistant")
        .pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      throw new Error("No assistant journal entry exists for this session")
    })

    const steer: Interface["steer"] = Effect.fn("SessionPrompt.steer")(function* (input) {
      if ((yield* status.get(input.sessionID)).type !== "busy") return false
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (session.parentID) return false
      const canonical = MessageV2.active(
        yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orElseSucceed(() => [])),
      )
      if (input.expectedEpoch && !SessionPhaseEpoch.matches(canonical, input.expectedEpoch)) return false
      const latest = MessageV2.latest(canonical)
      const appended = yield* submitPrompt({
        sessionID: input.sessionID,
        delivery: "immediate",
        noReply: true,
        ...steerHeadFields(latest.user),
        parts: input.parts,
        appendGuard: Effect.gen(function* () {
          if ((yield* status.get(input.sessionID)).type !== "busy") return false
          const messages = MessageV2.active(
            yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orElseSucceed(() => [])),
          )
          if (input.expectedEpoch && !SessionPhaseEpoch.matches(messages, input.expectedEpoch)) return false
          return true
        }),
      })
      if (!appended) return false
      yield* loop({ sessionID: input.sessionID }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("detached steered session loop failed", { sessionID: input.sessionID, cause }),
        ),
        Effect.forkDetach,
      )
      return true
    })

    const promoteNextDeferred = Effect.fn("SessionPrompt.promoteNextDeferred")(function* (sessionID: SessionID) {
      const next = MessageV2.nextDeferred(yield* MessageV2.filterCompactedEffect(sessionID))
      if (!next) return false
      const promoted = MessageV2.promoteDeferredUser(next.info)
      promoted.agent = yield* currentPhase(sessionID, promoted.agent)
      yield* sessions.updateMessage(promoted)
      return true
    })

    const createAssistant = Effect.fn("SessionPrompt.createAssistant")(function* (input: {
      user: MessageV2.User
      phase: string
      ctx: { directory: string; worktree: string }
    }) {
      return yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: input.user.sessionID,
        parentID: input.user.id,
        mode: input.phase,
        agent: input.phase,
        path: { cwd: input.ctx.directory, root: input.ctx.worktree },
        time: { created: Date.now() },
        role: "assistant",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.user.model.modelID,
        subsystemID: input.user.model.subsystemID,
      } satisfies MessageV2.Assistant)
    })

    const finishAssistant = Effect.fn("SessionPrompt.finishAssistant")(function* (input: {
      assistant: MessageV2.Assistant
      text: string
      usage: SubsystemUsage.Totals
    }) {
      input.assistant.finish = "stop"
      input.assistant.time.completed = Date.now()
      input.assistant.tokens = input.usage
      yield* sessions.updateMessage(input.assistant)
      const step = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.assistant.id,
        sessionID: input.assistant.sessionID,
        type: "step-finish",
        reason: "stop",
        tokens: input.usage,
      } satisfies MessageV2.StepFinishPart)
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.assistant.id,
        sessionID: input.assistant.sessionID,
        type: "text",
        text: input.text,
        time: { start: input.assistant.time.completed, end: input.assistant.time.completed },
      } satisfies MessageV2.TextPart)
      return { info: input.assistant, parts: [step, part] } satisfies MessageV2.WithParts
    })

    const finishCompletion = Effect.fn("SessionPrompt.finishCompletion")(function* (input: {
      assistant: MessageV2.Assistant
      usage: SubsystemUsage.Totals
      completion: Omit<MessageV2.CompletionPart, "id" | "messageID" | "sessionID" | "type">
    }) {
      input.assistant.finish = "stop"
      input.assistant.time.completed = Date.now()
      input.assistant.tokens = input.usage
      yield* sessions.updateMessage(input.assistant)
      const step = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.assistant.id,
        sessionID: input.assistant.sessionID,
        type: "step-finish",
        reason: "stop",
        tokens: input.usage,
      } satisfies MessageV2.StepFinishPart)
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.assistant.id,
        sessionID: input.assistant.sessionID,
        type: "completion",
        ...input.completion,
      } satisfies MessageV2.CompletionPart)
      return { info: input.assistant, parts: [step, part] } satisfies MessageV2.WithParts
    })

    const renderTerminalReport = Effect.fn("SessionPrompt.renderTerminalReport")(function* (input: {
      sessionID: SessionID
      directory: string
      workarea?: string
      workflow: string
    }) {
      const reportWorkarea = input.workarea ? workareaAbsolutePath(input.directory, input.workarea) : input.directory
      const report = SubsystemPhase.reportFor(input.workflow)
      const selected = SubsystemPhase.workflow(input.workflow)
      if (!report || !selected || selected.kind !== "workflow") return undefined
      const reportVars = new Map<string, SessionVariable.Value>(
        (yield* variables.entries(input.sessionID)).map((entry) => [entry.name, entry.value]),
      )
      const reportVar = (name: string) => {
        const value = reportVars.get(name)
        return typeof value === "string" && value.trim() ? value.trim() : undefined
      }
      const frameworks = (reportVar("compliance_frameworks") ?? "both").toLowerCase()
      const standards =
        frameworks === "soc2"
          ? "SOC 2"
          : frameworks === "iso27001"
            ? "ISO/IEC 27001:2022"
            : "SOC 2 & ISO/IEC 27001:2022"
      const engagementStart = reportVar("engagement_start")
      const engagementEnd = reportVar("engagement_end")
      const reportMeta: ReportMeta = {
        ...(input.workflow === "pentest" ? {} : { title: `${selected.title} Report` }),
        subtitle:
          input.workflow === "pentest"
            ? `Audit-ready · ${standards}`
            : input.workflow === "code-audit"
              ? "Architecture, source, supply chain, and isolated runtime evidence"
              : undefined,
        target: reportVar("client_name") ?? reportVar("target_base_url"),
        reportVersion: reportVar("report_version"),
        engagementWindow:
          engagementStart && engagementEnd
            ? `${engagementStart} to ${engagementEnd}`
            : (engagementStart ?? engagementEnd),
        ...(input.workflow === "code-audit"
          ? {
              subject: "Deep repository security audit",
              keywords: ["code audit", "threat model", "supply chain", "runtime attack", "SARIF"],
            }
          : {}),
      }
      const unresolved: string[] = []
      const resolveReportVariables = (markdown: string) => {
        const resolved = SessionVariable.resolveTemplatesLenient(markdown, (name) => reportVars.get(name))
        unresolved.push(...resolved.unresolved)
        return stripUnresolvedTemplates(resolved.text)
      }
      const reportPath =
        report.mime === "application/pdf"
          ? yield* Effect.tryPromise({
              try: () =>
                input.workflow === "pentest"
                  ? renderReportToPdf(reportWorkarea, resolveReportVariables, reportMeta)
                  : renderMarkdownReportToPdf({
                      workareaCwd: reportWorkarea,
                      sourcePath: report.source,
                      outputPath: report.path,
                      resolveVars: resolveReportVariables,
                      meta: reportMeta,
                    }),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) =>
                elog
                  .warn("report PDF rendering failed", {
                    sessionID: input.sessionID,
                    source: report.source,
                    error: errorMessage(cause),
                  })
                  .pipe(Effect.as(undefined)),
              ),
            )
          : yield* Effect.promise(async () => {
              const source = path.join(reportWorkarea, report.source)
              return (await Bun.file(source).exists()) ? source : undefined
            })
      const terminalPhase = selected.phases.at(-1)?.name
      if (terminalPhase && reportPath)
        yield* Effect.promise(() =>
          SubsystemPhaseRunner.writeArtifactManifest(
            SubsystemPhaseRunner.artifactManifestPath({
              workflow: input.workflow,
              phase: terminalPhase,
              workareaCwd: reportWorkarea,
            }),
            path.join(reportWorkarea, report.source),
          ),
        )
      if (unresolved.length)
        yield* elog.warn("report deliverable left variable templates unresolved", {
          sessionID: input.sessionID,
          names: [...new Set(unresolved)],
        })
      return reportPath
    })

    const runEngagement = Effect.fn("SessionPrompt.runEngagement")(function* (
      session: Session.Info,
      userMessage: MessageV2.WithParts,
    ) {
      if (userMessage.info.role !== "user") throw new Error("Pi engagement requires a user message")
      const ctx = yield* InstanceState.context
      const user = userMessage.info
      const workflow = session.workflow ?? SubsystemPhase.workflowOf(user.agent)
      if (!workflow) throw new Error(`A workflow is required to resolve phase '${user.agent}'`)
      const startPhase = SubsystemPhase.canonicalPhase(workflow, user.agent)
      const selectedWorkflow = SubsystemPhase.workflow(workflow)
      if (!selectedWorkflow || selectedWorkflow.kind !== "workflow")
        throw new Error(`Pi workflow requires a configured workflow, received '${workflow}'`)
      const workarea = typeof user.metadata?.workarea === "string" ? user.metadata.workarea : undefined
      if (!workarea) throw new Error(`${selectedWorkflow.title} requires an isolated workarea`)
      const workareaCwd = yield* Effect.promise(() => ensureWorkarea(ctx.directory, workarea))
      const objective = objectiveFromMessage(userMessage)
      const assistant = yield* createAssistant({ user, phase: startPhase, ctx })
      const container = SubsystemPhase.expertContainerName(workareaCwd, session.id)

      const bridge = yield* EffectBridge.make()
      const registryWorkflow = findingWorkflow(workflow)
      const findingStore = new FindingRegistry.Store(workareaCwd, {
        workarea,
        onUpdated: (revision) =>
          bridge.promise(
            events
              .publish(SessionFinding.Event.Updated, {
                sessionID: session.id,
                workarea,
                revision,
              })
              .pipe(Effect.asVoid),
          ),
      })
      yield* Effect.promise((signal) => findingStore.startRun({ id: session.id, workflow: registryWorkflow }, signal))
      const subsystem = PI_RUNTIME_DESCRIPTOR
      const generatedTokens = SubsystemUsage.createSessionCounter()
      const persistedOutputTokens = session.tokens?.output ?? 0
      const activePhaseRuns = new Set<object>()
      const hypothesisCalls = new Set<string>()
      const publishHypothesisRevision = () =>
        Effect.promise(() => readHypothesisRegistryView(workareaCwd, workflow)).pipe(
          Effect.flatMap((view) =>
            events.publish(SessionHypothesis.Event.Updated, {
              sessionID: session.id,
              workarea,
              revision: view.revision,
            }),
          ),
        )
      const publishPhase = (
        phase: string,
        kind: "start" | "end" | "text" | "tool" | "output" | "progress" | "status" | "agent",
        text = "",
        tool = "",
        actor?: PhaseActivityActor,
        actorState?: PhaseActivityActorState,
        actorTransitionID?: string,
        artifact?: PhaseActivityArtifact,
        usage?: SubsystemUsage.Snapshot,
      ) =>
        events.publish(SessionEvent.SubsystemPhaseActivity, {
          sessionID: session.id,
          timestamp: DateTime.makeUnsafe(Date.now()),
          phase,
          subsystem,
          kind,
          text,
          tool,
          ...(actor ? { actor } : {}),
          ...(actorState ? { actorState } : {}),
          ...(actorTransitionID ? { actorTransitionID } : {}),
          ...(artifact ? { artifact } : {}),
          ...(usage
            ? {
                usage: {
                  scopeID: usage.scopeID ?? "root",
                  inputTokens: usage.inputTokens ?? 0,
                  generatedTokens: usage.generatedTokens,
                  reasoningTokens: usage.reasoningTokens ?? 0,
                  cacheReadTokens: usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                },
              }
            : {}),
        })
      let prepareEngagementPhase: NonNullable<SubsystemPhaseRunner.PhaseDeps["preparePhase"]> = async () => ({
        warnings: [],
        env: {},
      })
      const runPhaseStreaming = async (spec: SubsystemPhaseRunner.PhaseSpec) => {
        const run = {}
        activePhaseRuns.add(run)
        try {
          await bridge.promise(publishPhase(spec.phase, "start"))
          await bridge.promise(
            publishPhase(spec.phase, "progress", String(persistedOutputTokens + generatedTokens.total())),
          )
          return await SubsystemPhaseRunner.runPhase(spec, {
            ...SubsystemPhaseRunner.defaultDeps(),
            preparePhase: (input) => prepareEngagementPhase(input),
            dynamicTools:
              spec.phase === "report"
                ? [
                    SessionFinding.dynamicTool(
                      findingStore,
                      { runID: session.id, workflow: registryWorkflow, phase: spec.phase },
                      { readonly: true },
                    ),
                  ]
                : registryWorkflow !== "code-audit" && FINDING_WRITE_PHASES.has(spec.phase)
                  ? [
                      SessionFinding.dynamicTool(
                        findingStore,
                        { runID: session.id, workflow: registryWorkflow, phase: spec.phase },
                        { readonly: false },
                      ),
                    ]
                  : undefined,
            askQuestion: (questions, signal) =>
              Effect.runPromise(
                bridge.run(
                  question.ask({
                    sessionID: session.id,
                    questions: questions.map((item) => ({
                      question: item.question,
                      header: item.header,
                      options: [...item.options],
                      multiple: item.multiple,
                      custom: item.custom,
                    })),
                  }),
                ),
                { signal },
              ),
            onActivity: (activity) => {
              if (spec.abort?.aborted) return
              // ── Reasoning Metadata Stays Inside The Runtime ─────────────
              // Reasoning observations describe subsystem payload shape rather than
              // engagement progress. The phase runner may use them for its final
              // observability summary, but publishing them would expose diagnostic
              // JSON as a user-facing TUI status row. Drop them at the event boundary.
              // ─────────────────────────────────────────────────────────────────
              if (activity.kind === "reasoning") return
              if (
                activity.kind === "tool" &&
                activity.tool === "hypothesis" &&
                typeof activity.input === "object" &&
                activity.input !== null &&
                "action" in activity.input &&
                !["get", "list", "status"].includes(String(activity.input.action))
              )
                hypothesisCalls.add(activity.callID)
              const hypothesisMutationCompleted =
                activity.kind === "output" && hypothesisCalls.delete(activity.callID)
              const hypothesisOwnershipRecovered =
                activity.kind === "status" &&
                activity.text.startsWith("Hypothesis ownership recovered by ")
              bridge.fork(
                publishPhase(
                  spec.phase,
                  activity.kind,
                  activity.kind === "text" || activity.kind === "output" || activity.kind === "status"
                    ? activity.text
                    : activity.kind === "tool"
                      ? JSON.stringify({ callID: activity.callID, input: activity.input })
                      : activity.kind === "progress"
                        ? String(persistedOutputTokens + generatedTokens.observe(run, activity.usage))
                        : "",
                  activity.kind === "tool" ? activity.tool : activity.kind === "output" ? activity.callID : "",
                  activity.actor,
                  activity.kind === "agent" ? activity.state : undefined,
                  activity.kind === "agent" ? activity.transitionID : undefined,
                  activity.kind === "output" ? activity.artifact : undefined,
                  activity.kind === "progress" ? activity.usage : undefined,
                ),
              )
              if (hypothesisMutationCompleted || hypothesisOwnershipRecovered)
                bridge.fork(publishHypothesisRevision())
            },
            onSemanticProgress: (progress) => {
              if (spec.abort?.aborted) return
              bridge.fork(publishPhase(spec.phase, "status", JSON.stringify({ semanticProgress: progress })))
            },
          })
        } finally {
          activePhaseRuns.delete(run)
          if (activePhaseRuns.size === 0) bridge.fork(publishPhase(spec.phase, "end"))
        }
      }
      const recordPhaseResult = async (
        spec: SubsystemPhaseRunner.PhaseSpec,
        result: SubsystemPhaseRunner.PhaseResult,
      ) => {
        bridge.fork(
          publishPhase(
            spec.phase,
            "status",
            JSON.stringify({
              ok: result.ok,
              termination: result.termination,
              backend: result.backend,
              durationMs: result.durationMs,
              limitMs: result.limitMs,
              effectiveLimitMs: result.effectiveLimitMs,
              deadlineAt: result.deadlineAt,
              approvalWaitMs: result.approvalWaitMs,
              targetCooldownWaitMs: result.targetCooldownWaitMs,
              exitCode: result.exitCode,
              failure: result.phaseFailure,
              subsystemFailure: result.subsystemFailure,
              warnings: result.warnings,
              handoff: result.handoff
                ? {
                    successor: result.handoff.successor,
                    artifact: result.handoff.artifact,
                    verdicts: result.handoff.verdicts ? SubsystemVerdict.counts(result.handoff.verdicts) : undefined,
                  }
                : undefined,
              usage: result.usage,
              contextChurn: result.contextChurn,
              reasoningObservability: result.reasoningObservability,
              agentRun: result.agentRun,
              noveltyContract: result.noveltyContract,
              artifactManifest: result.artifactManifest,
              runtimeManifest: result.runtimeManifest,
              semanticCheckpoints: result.semanticCheckpoints,
              lastSemanticProgressAt: result.lastSemanticProgressAt,
            }),
          ),
        )
      }
      let syncCodeGraphLedger = (_phase: string) => Promise.resolve()
      const runPhaseWithStatus = async (spec: SubsystemPhaseRunner.PhaseSpec) => {
        let result = await runPhaseStreaming(spec)
        await syncCodeGraphLedger(spec.phase)
        const registryWarning = await findingHandoffWarning(findingStore, {
          runID: session.id,
          workflow: registryWorkflow,
          phase: spec.phase,
          verdicts: result.handoff?.verdicts,
          snapshot: result.handoff?.snapshot,
        })
        if (registryWarning)
          result = {
            ...result,
            ok: false,
            warnings: [...result.warnings, registryWarning],
          }
        await recordPhaseResult(spec, result)
        return result
      }
      const codeGraphLedgerKey = SubsystemPhase.hasCapability(workflow, "code-graph")
        ? yield* variables.hostSecret({
            sessionID: session.id,
            name: SessionVariable.Name.make("_cyberful_host_code_graph_ledger_key"),
          })
        : undefined
      const sourceStore = SubsystemPhase.hasCapability(workflow, "source")
        ? yield* Effect.promise(() => HostSourceStore.ensureSourceStore(workareaCwd))
        : undefined
      const ghidraStore = SubsystemPhase.hasCapability(workflow, "ghidra")
        ? yield* Effect.promise(() => HostGhidraStore.ensureGhidraStore(workareaCwd))
        : undefined
      if (registryWorkflow === "code-audit") {
        syncCodeGraphLedger = async (phase: string) => {
          const service = await createCodeGraphService({
            sourceRoot: sourceStore?.root ?? ctx.directory,
            workareaRoot: workareaCwd,
          })
          try {
            const integrity = service.findingIntegrityState()
            await findingStore.syncCodeGraph(
              integrity.findings.map((finding) => ({
                id: finding.id,
                title: finding.title,
                weakness: finding.weakness,
                severity: finding.severity,
                confidence: finding.confidence,
                status: finding.status,
                updatedAt: finding.updatedAt,
                evidence: finding.evidence,
                transitionReason: integrity.transitions
                  .filter((transition) => transition.findingId === finding.id)
                  .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
                  .at(-1)?.reason,
              })),
              { runID: session.id, workflow: registryWorkflow, phase },
            )
          } finally {
            await service.close()
          }
        }
        yield* Effect.promise(async () => {
          const service = await createCodeGraphService({
            sourceRoot: sourceStore?.root ?? ctx.directory,
            workareaRoot: workareaCwd,
          })
          try {
            const integrity = service.findingIntegrityState()
            await findingStore.syncCodeGraph(
              integrity.findings.map((finding) => ({
                id: finding.id,
                title: finding.title,
                weakness: finding.weakness,
                severity: finding.severity,
                confidence: finding.confidence,
                status: finding.status,
                updatedAt: finding.updatedAt,
                evidence: finding.evidence,
                transitionReason: integrity.transitions
                  .filter((transition) => transition.findingId === finding.id)
                  .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
                  .at(-1)?.reason,
              })),
              { runID: session.id, workflow: registryWorkflow, phase: "legacy-import" },
              { historical: true },
            )
          } finally {
            await service.close()
          }
        })
      }
      // ── One Host Owner Fixes Runtime Policy Before Any Phase ───────
      // The engagement container starts once after durable stores exist and before
      // the first private gateway. Its network mode, mounts, service credentials,
      // and proxy publication therefore cannot drift during handoff. Optional
      // service failures degrade the shared runtime, while core image or container
      // failures abort before an autonomous phase can observe partial capability.
      // ─────────────────────────────────────────────────────────────────
      const engagementRuntime = yield* Effect.promise(async (signal) => {
        const diagnostics = new RuntimeDiagnosticRecorder({
          workarea: workareaCwd,
          sessionID: session.id,
          workflow,
          phase: startPhase,
          attempt: 1,
        })
        try {
          return await SubsystemEngagementRuntime.startEngagement({
            sessionID: session.id,
            workflow,
            container,
            workarea: workareaCwd,
            ...(ghidraStore ? { ghidraStore: ghidraStore.root } : {}),
            objective,
            signal,
            onDiagnostic: (diagnostic) =>
              diagnostics.record({
                component: diagnostic.component,
                profile: "engagement",
                stage: "startup",
                severity: diagnostic.severity,
                errorClass: diagnostic.errorClass,
                message: diagnostic.message,
              }),
          })
        } finally {
          await diagnostics.close().catch(() => undefined)
        }
      })
      prepareEngagementPhase = engagementRuntime.preparePhase
      const engagementEvm = SubsystemPhase.hasCapability(workflow, "evm-lab")
        ? yield* Effect.promise(async () => {
            try {
              return await SubsystemEvmRuntime.startEngagement({
                sessionID: session.id,
                workarea: workareaCwd,
                container: engagementRuntime.env.CYBERFUL_OS_CONTAINER ?? "",
              })
            } catch (error) {
              await engagementRuntime.stop().catch((cleanupError) => {
                throw new AggregateError([error, cleanupError], "EVM startup and engagement runtime cleanup failed")
              })
              throw error
            }
          })
        : { env: {}, stop: () => Promise.resolve() }
      const runtimeWarnings = engagementRuntime.warnings
      const engagementObjective =
        runtimeWarnings.length > 0
          ? `${objective}\n\n## Runtime warning\n${runtimeWarnings.join("\n")}\nContinue within scope using the remaining tools.`
          : objective
      let findingRunStatus: Exclude<FindingRegistry.RunStatus, "RUNNING"> = "FAILED"
      let terminalOutcome: SubsystemOrchestrator.AdvanceOutcome | undefined
      const outcome = yield* SubsystemOrchestrator.runAndAdvance(
        {
          sessionID: session.id,
          startPhase,
          workflow,
          objective: engagementObjective,
          workareaCwd,
          sourceRoot: ctx.directory,
          home: SubsystemPhase.workflowHome(workflow),
          settingsDirectory: ctx.directory,
          path: { cwd: ctx.directory, root: ctx.worktree },
          timeoutMs: SubsystemPhase.DEFAULT_PHASE_BUDGET_MINUTES * 60_000,
          degraded: EngagementStatus.isDegraded(user.metadata) || engagementRuntime.degraded,
          env: {
            ...engagementRuntime.env,
            ...engagementEvm.env,
            ...(codeGraphLedgerKey ? { CYBERFUL_CODE_GRAPH_LEDGER_KEY: codeGraphLedgerKey } : {}),
            ...(sourceStore
              ? {
                  CYBERFUL_SOURCE_STORE_ROOT: sourceStore.root,
                  CYBERFUL_SOURCE_IMPORT_ATTESTATION_KEY: sourceStore.attestationKey,
                }
              : {}),
          },
        },
        { runPhase: runPhaseWithStatus },
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            terminalOutcome = result
          }),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            findingRunStatus = result.terminal ? "COMPLETED" : "BLOCKED"
          }),
        ),
        Effect.ensuring(
          Effect.promise((signal) => findingStore.finishRun({ id: session.id, status: findingRunStatus }, signal)),
        ),
        Effect.ensuring(Effect.promise(engagementEvm.stop)),
        Effect.ensuring(Effect.promise(engagementRuntime.stop)),
        Effect.ensuring(
          Effect.promise(async () => {
            try {
              const cleanup = await SubsystemContainer.removeSession(session.id, engagementRuntime.containers)
              await SubsystemRunStateArtifact.recordTerminalCleanup({
                workarea: workareaCwd,
                sessionID: session.id,
                state: "closed",
                removed: cleanup.removed,
                remaining: cleanup.remaining,
                ...(terminalOutcome
                  ? {
                      terminal: {
                        ...(terminalOutcome.haltedAt ?? terminalOutcome.ranPhases.at(-1)
                          ? { phase: terminalOutcome.haltedAt ?? terminalOutcome.ranPhases.at(-1) }
                          : {}),
                        outcome: terminalOutcome.outcome,
                        ...(terminalOutcome.termination ? { termination: terminalOutcome.termination } : {}),
                        ...(terminalOutcome.failure ? { failure: terminalOutcome.failure } : {}),
                      },
                    }
                  : {}),
              })
            } catch (error) {
              const removed =
                error instanceof SubsystemContainer.SessionContainerCleanupError
                  ? error.removed
                  : []
              const remaining =
                error instanceof SubsystemContainer.SessionContainerCleanupError
                  ? error.remaining
                  : [...engagementRuntime.containers]
              await SubsystemRunStateArtifact.recordTerminalCleanup({
                workarea: workareaCwd,
                sessionID: session.id,
                state: "closed_with_cleanup_errors",
                removed,
                remaining,
                ...(terminalOutcome
                  ? {
                      terminal: {
                        ...(terminalOutcome.haltedAt ?? terminalOutcome.ranPhases.at(-1)
                          ? { phase: terminalOutcome.haltedAt ?? terminalOutcome.ranPhases.at(-1) }
                          : {}),
                        outcome: terminalOutcome.outcome,
                        ...(terminalOutcome.termination ? { termination: terminalOutcome.termination } : {}),
                        ...(terminalOutcome.failure ? { failure: terminalOutcome.failure } : {}),
                      },
                    }
                  : {}),
              }).catch((stateError) => {
                throw new AggregateError(
                  [error, stateError],
                  "engagement container cleanup and terminal state persistence failed",
                )
              })
              throw error
            }
          }),
        ),
      )

      const terminalReportPath = outcome.terminal
        ? yield* renderTerminalReport({ sessionID: session.id, directory: ctx.directory, workarea, workflow })
        : undefined
      const artifacts = yield* Effect.promise(() =>
        SessionCompletion.validateArtifacts(workareaCwd, [
          ...(outcome.terminal ? SubsystemPhase.terminalArtifacts(workflow) : []),
          ...(outcome.terminal && !terminalReportPath
            ? [
                {
                  label: "Report source",
                  path: selectedWorkflow.report.source,
                  mime: "text/markdown",
                  primary: true,
                },
              ]
            : []),
          ...(outcome.completion?.artifacts ?? []),
        ]),
      )
      const declaredTerminalArtifacts = outcome.terminal ? SubsystemPhase.terminalArtifacts(workflow) : []
      const completedArtifactPaths = new Set(artifacts.map((artifact) => artifact.path))
      const missingTerminalArtifacts = declaredTerminalArtifacts.filter(
        (artifact) => !completedArtifactPaths.has(artifact.path),
      )
      if (missingTerminalArtifacts.length)
        yield* elog.warn("terminal workflow artifacts are missing", {
          sessionID: session.id,
          workflow,
          paths: missingTerminalArtifacts.map((artifact) => artifact.path),
        })
      const completionOutcome: MessageV2.CompletionPart["outcome"] =
        outcome.terminal && outcome.outcome === "success" && (!terminalReportPath || missingTerminalArtifacts.length > 0)
          ? "warning"
          : outcome.outcome
      const lastPhase = outcome.ranPhases.at(-1) ?? startPhase
      assistant.agent = lastPhase
      assistant.mode = lastPhase
      const nextWorkflow = SubsystemPhase.nextWorkflow(workflow)
      const finished = yield* finishCompletion({
        assistant,
        usage: generatedTokens.usage(),
        completion: {
          workflow,
          outcome: completionOutcome,
          title: SubsystemCompletion.normalizeTitle(
            outcome.completion?.title,
            outcome.terminal
              ? selectedWorkflow.completionTitle
              : `${selectedWorkflow.title} stopped at ${outcome.haltedAt ?? startPhase}`,
          ),
          summaryMarkdown: SubsystemCompletion.normalizeSummary(
            outcome.completion?.summaryMarkdown,
            outcome.summary || "The run ended without a subsystem summary.",
          ),
          workarea,
          artifacts,
          nextWorkflow,
          startedPhase: startPhase,
          lastPhase,
          ranPhases: outcome.ranPhases,
          failure: outcome.failure,
        },
      })
      if (nextWorkflow) {
        const nextAgent = SubsystemPhase.workflowKickoffPhase(nextWorkflow)
        if (nextAgent) yield* sessions.setWorkflow({ sessionID: session.id, workflow: nextWorkflow, agent: nextAgent })
      }
      return finished
    })

    const runAsk = Effect.fn("SessionPrompt.runAsk")(function* (
      session: Session.Info,
      userMessage: MessageV2.WithParts,
    ) {
      if (userMessage.info.role !== "user") throw new Error("Ask requires a user message")
      const ctx = yield* InstanceState.context
      const user = userMessage.info
      const workarea = typeof user.metadata?.workarea === "string" ? user.metadata.workarea : undefined
      if (!workarea) throw new Error("Ask requires an existing workarea")
      const requestedWorkarea = workareaAbsolutePath(ctx.directory, workarea)
      const workareaInfo = yield* Effect.promise(() => lstatIfPresent(requestedWorkarea))
      if (!workareaInfo?.isDirectory() || workareaInfo.isSymbolicLink())
        throw new Error("Ask requires an existing regular workarea directory")
      const workareaCwd = yield* Effect.promise(() => ensureWorkarea(ctx.directory, workarea))
      const objective = objectiveFromMessage(userMessage)
      const history = SessionAskContext.buildAskContext(
        MessageV2.active(yield* MessageV2.filterCompactedEffect(session.id)),
        user.id,
      )
      const assistant = yield* createAssistant({ user, phase: "ask", ctx })
      const runtime = yield* Effect.promise((signal) =>
        SubsystemAskRuntime.acquire({ sessionID: session.id, workarea: workareaCwd, objective, signal }),
      )
      const bridge = yield* EffectBridge.make()
      const subsystem = PI_RUNTIME_DESCRIPTOR
      const generatedTokens = SubsystemUsage.createSessionCounter()
      const persistedOutputTokens = session.tokens?.output ?? 0
      const publish = (
        kind: "start" | "end" | "text" | "tool" | "output" | "progress" | "status" | "agent",
        text = "",
        tool = "",
        actor?: PhaseActivityActor,
        actorState?: PhaseActivityActorState,
        actorTransitionID?: string,
        artifact?: PhaseActivityArtifact,
        usage?: SubsystemUsage.Snapshot,
      ) =>
        events.publish(SessionEvent.SubsystemPhaseActivity, {
          sessionID: session.id,
          timestamp: DateTime.makeUnsafe(Date.now()),
          phase: "ask",
          subsystem,
          kind,
          text,
          tool,
          ...(actor ? { actor } : {}),
          ...(actorState ? { actorState } : {}),
          ...(actorTransitionID ? { actorTransitionID } : {}),
          ...(artifact ? { artifact } : {}),
          ...(usage
            ? {
                usage: {
                  scopeID: usage.scopeID ?? "root",
                  inputTokens: usage.inputTokens ?? 0,
                  generatedTokens: usage.generatedTokens,
                  reasoningTokens: usage.reasoningTokens ?? 0,
                  cacheReadTokens: usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                },
              }
            : {}),
        })
      const runtimeObjective = [
        history,
        "## Current request",
        objective,
        runtime.warnings.length > 0 ? `## Runtime warning\n${runtime.warnings.join("\n")}` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n")
      const askRun = {}
      yield* publish("start")
      const result = yield* Effect.promise((abort) =>
        SubsystemPhaseRunner.runPhase(
          {
            phase: "ask",
            workflow: "ask",
            kind: "interactive",
            sessionID: session.id,
            workareaCwd,
            home: SubsystemPhase.workflowHome("ask"),
            settingsDirectory: ctx.directory,
            objective: runtimeObjective,
            timeoutMs: SubsystemPhase.DEFAULT_PHASE_BUDGET_MINUTES * 60_000,
            abort,
            env: runtime.env,
            transcriptPath: SessionReportLog.expertTranscriptFile(
              { directory: ctx.directory, worktree: ctx.worktree },
              session.id,
              `ask-${user.id}`,
            ),
          },
          {
            ...SubsystemPhaseRunner.defaultDeps(),
            askQuestion: (questions, signal) =>
              Effect.runPromise(
                bridge.run(
                  question.ask({
                    sessionID: session.id,
                    questions: questions.map((item) => ({
                      question: item.question,
                      header: item.header,
                      options: [...item.options],
                      multiple: item.multiple,
                      custom: item.custom,
                    })),
                  }),
                ),
                { signal },
              ),
            onActivity: (activity) => {
              // ── Reasoning Metadata Stays Inside The Runtime ─────────────
              // Ask shares the phase activity envelope, so it must enforce the same
              // presentation boundary as workflow phases. Subsystem reasoning shape
              // remains available to the runner, while the public event stream carries
              // only progress that the operator can act on or meaningfully inspect.
              // ─────────────────────────────────────────────────────────────────
              if (activity.kind === "reasoning") return
              bridge.fork(
                publish(
                  activity.kind,
                  activity.kind === "text" || activity.kind === "output" || activity.kind === "status"
                    ? activity.text
                    : activity.kind === "tool"
                      ? JSON.stringify({ callID: activity.callID, input: activity.input })
                      : activity.kind === "progress"
                        ? String(persistedOutputTokens + generatedTokens.observe(askRun, activity.usage))
                        : "",
                  activity.kind === "tool" ? activity.tool : activity.kind === "output" ? activity.callID : "",
                  activity.actor,
                  activity.kind === "agent" ? activity.state : undefined,
                  activity.kind === "agent" ? activity.transitionID : undefined,
                  activity.kind === "output" ? activity.artifact : undefined,
                  activity.kind === "progress" ? activity.usage : undefined,
                ),
              )
            },
          },
        ),
      ).pipe(Effect.ensuring(Effect.sync(() => SubsystemAskRuntime.release(session.id))))
      yield* publish(
        "status",
        JSON.stringify({
          ok: result.ok,
          termination: result.termination,
          backend: result.backend,
          durationMs: result.durationMs,
          limitMs: result.limitMs,
          effectiveLimitMs: result.effectiveLimitMs,
          deadlineAt: result.deadlineAt,
          approvalWaitMs: result.approvalWaitMs,
          targetCooldownWaitMs: result.targetCooldownWaitMs,
          exitCode: result.exitCode,
          failure: result.phaseFailure,
          warnings: result.warnings,
        }),
      )
      yield* publish("end")
      const answer = result.summary.trim() || "Ask could not produce a response."
      return yield* finishAssistant({
        assistant,
        usage: generatedTokens.usage(),
        text: result.ok ? answer : `${answer}\n\n> Ask ended with ${result.termination}.`,
      })
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID) {
        while (true) {
          const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
          yield* status.set(sessionID, { type: "busy" })
          const messages = MessageV2.active(yield* MessageV2.filterCompactedEffect(sessionID))
          const user = MessageV2.latest(messages).user
          const userMessage = user && messages.find((message) => message.info.id === user.id)
          if (!user || !userMessage) throw new Error("No user message found for Pi engagement")
          if (!SessionRuntimeCompatibility.canExecuteWithPi(SessionRuntimeCompatibility.classify(messages)))
            return yield* legacyRuntimeError(sessionID)
          const workflow = session.workflow ?? SubsystemPhase.workflowOf(user.agent)
          if (workflow === "ask") {
            const result = yield* runAsk(session, userMessage)
            if (!(yield* promoteNextDeferred(sessionID))) return result
            continue
          }
          if (!workflow || !SubsystemPhase.isExpertPhase(workflow, user.agent)) {
            const error = new NamedError.Unknown({ message: `Unsupported non-Pi phase: ${user.agent}` })
            yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
            throw error
          }
          const result = yield* runEngagement(session, userMessage)
          if (!(yield* promoteNextDeferred(sessionID))) return result
        }
      },
    )

    const loop: Interface["loop"] = Effect.fn("SessionPrompt.loop")(function* (input) {
      // Open steering before Runner publishes busy. The UI can therefore never observe a steerable session
      // before the control plane is ready to hold input for its current turn or next phase.
      const closeSteering = SubsystemControl.open(input.sessionID)
      return yield* state
        .ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
        .pipe(Effect.ensuring(Effect.sync(closeSteering)))
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const prepared = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            yield* revert.cleanup(session)
            const phase = yield* currentPhase(input.sessionID, input.agent)
            const configuredMarker = DependencyConfig.expertSessionModel()
            const marker = {
              subsystemID: SubsystemID.make(configuredMarker.subsystemID),
              modelID: ModelID.make(configuredMarker.modelID),
            }
            const user = yield* sessions.updateMessage({
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: phase,
              model: marker,
            } satisfies MessageV2.User)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: input.sessionID,
              type: "text",
              text: "The following shell command was executed by the user.",
              synthetic: true,
            } satisfies MessageV2.TextPart)
            const assistantInfo: MessageV2.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: user.id,
              mode: phase,
              agent: phase,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: marker.modelID,
              subsystemID: marker.subsystemID,
            }
            const assistant = yield* sessions.updateMessage(assistantInfo)
            const started = Date.now()
            let part: MessageV2.ToolPart = yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: input.sessionID,
              type: "tool",
              tool: ShellID.ToolID,
              callID: ulid(),
              state: { status: "running", time: { start: started }, input: { command: input.command } },
            } satisfies MessageV2.ToolPart)
            if (flags.experimentalEventSystem)
              yield* events.publish(SessionEvent.Shell.Started, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(started),
                callID: part.callID,
                command: input.command,
              })
            yield* status.set(input.sessionID, { type: "busy", message: "executing shell command" })
            return { ctx, assistant, part }
          }).pipe(Effect.ensuring(markReady))
          let part = prepared.part

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const command = yield* variables.resolveTemplates(input.sessionID, input.command)
          if (typeof command !== "string") throw new Error("Shell command variable template must resolve to a string")
          // ── Shell Journaling Retains A Bounded Final Window ────────
          // User-invoked commands can emit indefinitely even when the process has
          // a scoped cancellation owner. The stream must still be drained to avoid
          // blocking the child, but session state and live UI updates retain only
          // a fixed final byte window. A visible omission marker makes truncation
          // explicit without keeping discarded output in memory or the journal.
          // The session scope, rather than an arbitrary wall deadline, owns
          // cancellation because user commands may intentionally run for a while.
          // ─────────────────────────────────────────────────────────────────
          const retainedOutput = createShellOutputTail()
          let output = ""
          let aborted = false
          const exit = yield* restore(
            Effect.gen(function* () {
              const process = ChildProcess.make(sh, Shell.args(sh, command, prepared.ctx.directory), {
                cwd: prepared.ctx.directory,
                extendEnv: true,
                env: { TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(process)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  retainedOutput.append(yield* variables.redact(input.sessionID, chunk))
                  output = renderShellOutput(retainedOutput)
                  if (part.state.status === "running") {
                    part.state.metadata = { output, description: "" }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)
          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) aborted = true
          output = yield* variables.redact(input.sessionID, output)
          if (aborted) output += "\n\n<metadata>\nUser aborted the command\n</metadata>"
          const completed = Date.now()
          if (flags.experimentalEventSystem)
            yield* events.publish(SessionEvent.Shell.Ended, {
              sessionID: input.sessionID,
              timestamp: DateTime.makeUnsafe(completed),
              callID: part.callID,
              output,
            })
          prepared.assistant.finish = "tool-calls"
          prepared.assistant.time.completed = completed
          yield* sessions.updateMessage(prepared.assistant)
          const started = part.state.status === "running" ? part.state.time.start : completed
          const shellInput = part.state.input
          part.state = {
            status: "completed",
            time: { start: started, end: completed },
            input: shellInput,
            title: "",
            metadata: { output, description: "" },
            output,
          }
          yield* sessions.updatePart(part)
          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause))
            return yield* Effect.failCause(exit.cause)
          return { info: prepared.assistant, parts: [part] }
        }),
      )
    })

    const shell: Interface["shell"] = Effect.fn("SessionPrompt.shell")(function* (input) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const command: Interface["command"] = Effect.fn("SessionPrompt.command")(function* (input) {
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((item) => item.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((argument) => argument.replace(quoteTrimRegex, ""))
      const templateCommand = awaitTemplate(cmd.template)
      const source = yield* Effect.promise(() => templateCommand)
      const placeholders = source.match(placeholderRegex) ?? []
      const last = placeholders.reduce((result, item) => Math.max(result, Number(item.slice(1))), 0)
      let template = source.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argumentIndex = position - 1
        if (argumentIndex >= args.length) return ""
        if (position === last) return args.slice(argumentIndex).join(" ")
        return args[argumentIndex]
      })
      const usesArguments = source.includes("$ARGUMENTS")
      template = template.replaceAll("$ARGUMENTS", input.arguments)
      if (placeholders.length === 0 && !usesArguments && input.arguments.trim()) template += `\n\n${input.arguments}`
      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const sh = Shell.preferred((yield* config.get()).shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, value]) => (await Process.text([value], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++] ?? "")
      }
      const parts: PromptInput["parts"] = [...(yield* resolvePromptParts(template.trim())), ...(input.parts ?? [])]
      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        agent: input.agent,
        delivery: input.delivery,
        system: input.system,
        workarea: input.workarea,
        parts,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({ cancel, prompt, steer, loop, shell, command, resolvePromptParts })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionVariable.defaultLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Event.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

function validateJournalMessage(info: MessageV2.User, parts: MessageV2.Part[]) {
  const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
  if (Exit.isFailure(parsed)) log.error("invalid Pi user journal message", { cause: Cause.pretty(parsed.cause) })
  parts.forEach((part, index) => {
    const parsedPart = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
    if (Exit.isFailure(parsedPart))
      log.error("invalid Pi journal part", {
        partID: part.id,
        partType: part.type,
        index,
        cause: Cause.pretty(parsedPart.cause),
      })
  })
}

function awaitTemplate(template: Command.Info["template"]): Promise<string> {
  return Promise.resolve(template)
}

const bashRegex = /!`([^`]+)`/g
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export { CommandInput, Delivery, LoopInput, PromptInput, ShellInput } from "./prompt-input"
export * as SessionPrompt from "./prompt"
