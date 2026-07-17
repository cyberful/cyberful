// ── Interactive Run Orchestrator ─────────────────────────────────
// Wires boot data, renderer lifecycle, event transport, and the serialized
//   prompt queue for attached or in-process sessions, with lazy creation for a
//   fresh local session and ordered cleanup on every exit path.
// ─────────────────────────────────────────────────────────────────

import { createLocalControlPlaneClient } from "@/server/client/local"
import { Flag } from "@/flag/flag"
import { createRunDemo } from "./demo"
import { resolveDiffStyle, resolveFooterKeybinds, resolveSessionInfo } from "./runtime.boot"
import { createRuntimeLifecycle } from "./runtime.lifecycle"
import type { RunInput, RunPrompt } from "./types"
import { observePromise } from "@/util/promise"
import * as Log from "@/util/log"

const log = Log.create({ service: "run.runtime" })

/** @internal Exported for testing */
export { runPromptQueue } from "./runtime.queue"

type BootContext = Pick<RunInput, "sdk" | "directory" | "sessionID" | "sessionTitle" | "resume" | "agent">

type CreateSessionInput = {
  agent: string | undefined
}

type CreateSession = (sdk: RunInput["sdk"], input: CreateSessionInput) => Promise<{ id: string; title?: string }>

type RunRuntimeInput = {
  boot: () => Promise<BootContext>
  resolveSession?: (
    ctx: BootContext,
  ) => Promise<{ sessionID: string; sessionTitle?: string; agent?: string | undefined }>
  createSession?: (ctx: BootContext, input: CreateSessionInput) => Promise<ResolvedSession>
  files: RunInput["files"]
  system?: RunInput["system"]
  workarea?: RunInput["workarea"]
  initialInput?: string
  thinking: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
}

type RunLocalInput = {
  directory: string
  resolveAgent: () => Promise<string | undefined>
  session: (sdk: RunInput["sdk"]) => Promise<{ id: string; title?: string } | undefined>
  createSession?: CreateSession
  agent: RunInput["agent"]
  system?: RunInput["system"]
  workarea?: RunInput["workarea"]
  files: RunInput["files"]
  initialInput?: string
  thinking: boolean
  replay?: boolean
  replayLimit?: number
  demo?: RunInput["demo"]
}

type StreamState = {
  mod: Awaited<typeof import("./stream.transport")>
  handle: Awaited<ReturnType<Awaited<typeof import("./stream.transport")>["createSessionTransport"]>>
}

type ResolvedSession = {
  sessionID: string
  sessionTitle?: string
  agent?: string | undefined
}

function createSessionResolver(fn?: CreateSession) {
  if (!fn) {
    return undefined
  }

  return async (ctx: BootContext, input: CreateSessionInput): Promise<ResolvedSession> => {
    const created = await fn(ctx.sdk, input)
    if (!created.id) {
      throw new Error("Failed to create session")
    }

    return {
      sessionID: created.id,
      sessionTitle: created.title,
      agent: input.agent,
    }
  }
}

type RuntimeState = {
  shown: boolean
  aborting: boolean
  limits: Record<string, number>
  sessionID: string
  history: RunPrompt[]
  sessionTitle?: string
  agent: string | undefined
  demo?: ReturnType<typeof createRunDemo>
  selectSubagent?: (sessionID: string | undefined) => void
  session?: Promise<void>
  stream?: Promise<StreamState>
}

function hasSession(input: RunRuntimeInput, state: RuntimeState) {
  return !input.resolveSession || !!state.sessionID
}

function eagerStream(input: RunRuntimeInput, ctx: BootContext) {
  return ctx.resume === true || !input.resolveSession || !!input.demo
}

async function resolveExitTitle(
  ctx: BootContext,
  input: RunRuntimeInput,
  state: RuntimeState,
): Promise<string | undefined> {
  if (!state.shown || !hasSession(input, state)) {
    return undefined
  }

  return ctx.sdk.session
    .get({
      sessionID: state.sessionID,
    })
    .then((x) => x.data?.title)
    .catch((error) => {
      log.debug("failed to resolve session title during shutdown", { error, sessionID: state.sessionID })
      return undefined
    })
}

// ── Attachments Belong Only To The First Runtime Turn ────────────
// Boot establishes the control plane before renderer, transport, and queue take
// ownership in that order. Initial files are part of the launch prompt, not
// reusable session context, so the first accepted turn consumes them and every
// later turn sends only its newly composed content. Cleanup unwinds those owners
// in reverse when the queue exits or startup fails.
// ─────────────────────────────────────────────────────────────────
async function runInteractiveRuntime(input: RunRuntimeInput): Promise<void> {
  const start = performance.now()
  const keybindTask = resolveFooterKeybinds()
  const diffTask = resolveDiffStyle()
  const ctx = await input.boot()
  const sessionTask =
    ctx.resume === true
      ? resolveSessionInfo(ctx.sdk, ctx.sessionID)
      : Promise.resolve({
          first: true,
          history: [],
        })
  const [keybinds, diffStyle, session] = await Promise.all([keybindTask, diffTask, sessionTask])
  const state: RuntimeState = {
    shown: !session.first,
    aborting: false,
    limits: {},
    sessionID: ctx.sessionID,
    history: [...session.history],
    sessionTitle: ctx.sessionTitle,
    agent: ctx.agent,
  }
  const ensureSession = () => {
    if (!input.resolveSession || state.sessionID) {
      return Promise.resolve()
    }

    if (state.session) {
      return state.session
    }

    state.session = input.resolveSession(ctx).then((next) => {
      state.sessionID = next.sessionID
      state.sessionTitle = next.sessionTitle ?? state.sessionTitle
      state.agent = next.agent
    })
    return state.session
  }

  const shell = await createRuntimeLifecycle({
    directory: ctx.directory,
    findFiles: (query) =>
      ctx.sdk.find
        .files({ query, directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch((error) => {
          log.debug("failed to resolve interactive file suggestions", { error, query })
          return []
        }),
    agents: [],
    sessionID: state.sessionID,
    sessionTitle: state.sessionTitle,
    getSessionID: () => state.sessionID,
    first: session.first,
    history: session.history,
    agent: state.agent,
    keybinds,
    diffStyle,
    onQuestionReply: async (next) => {
      if (state.demo?.questionReply(next)) {
        return
      }

      await ctx.sdk.question.reply(next)
    },
    onQuestionReject: async (next) => {
      if (state.demo?.questionReject(next)) {
        return
      }

      await ctx.sdk.question.reject(next)
    },
    onInterrupt: () => {
      if (!hasSession(input, state) || state.aborting) {
        return
      }

      state.aborting = true
      const sessionID = state.sessionID
      observePromise(
        ctx.sdk.session.abort(
          { sessionID },
          {
            signal: AbortSignal.timeout(10_000),
          },
        ),
        {
          rejected: (error) => log.debug("session abort did not complete", { error, sessionID }),
          settled: () => {
            state.aborting = false
          },
        },
      )
    },
    onSubagentSelect: (sessionID) => {
      state.selectSubagent?.(sessionID)
    },
  })
  const footer = shell.footer

  const loadCatalog = async (): Promise<void> => {
    if (footer.isClosed) {
      return
    }

    const [agents, commands] = await Promise.all([
      ctx.sdk.app
        .agents({ directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch((error) => {
          log.debug("failed to load agent catalog", { error, directory: ctx.directory })
          return []
        }),
      ctx.sdk.command
        .list({ directory: ctx.directory })
        .then((x) => x.data ?? [])
        .catch((error) => {
          log.debug("failed to load command catalog", { error, directory: ctx.directory })
          return []
        }),
    ])
    if (footer.isClosed) {
      return
    }

    footer.event({
      type: "catalog",
      agents,
      commands,
    })
  }

  observePromise(footer.idle().then(loadCatalog), {
    rejected: (error) => log.debug("failed to load footer catalog", { error }),
  })

  if (Flag.CYBERFUL_SHOW_TTFD) {
    footer.append({
      kind: "system",
      text: `startup ${Math.max(0, Math.round(performance.now() - start))}ms`,
      phase: "final",
      source: "system",
    })
  }

  if (input.demo) {
    await ensureSession()
    state.demo = createRunDemo({
      footer,
      sessionID: state.sessionID,
      thinking: input.thinking,
      limits: () => state.limits,
    })
  }

  const streamTask = import("./stream.transport")
  const ensureStream = () => {
    if (state.stream) {
      return state.stream
    }

    // Share eager prewarm and first-turn boot through one in-flight promise,
    // but clear it if transport creation fails so a later prompt can retry.
    const next = (async () => {
      await ensureSession()
      if (footer.isClosed) {
        throw new Error("runtime closed")
      }

      const mod = await streamTask
      if (footer.isClosed) {
        throw new Error("runtime closed")
      }

      const handle = await mod.createSessionTransport({
        sdk: ctx.sdk,
        directory: ctx.directory,
        sessionID: state.sessionID,
        thinking: input.thinking,
        replay: input.replay,
        replayLimit: input.replayLimit,
        system: input.system,
        workarea: input.workarea,
        limits: () => state.limits,
        footer,
      })
      if (footer.isClosed) {
        await handle.close()
        throw new Error("runtime closed")
      }

      state.selectSubagent = (sessionID) => handle.selectSubagent(sessionID)
      return { mod, handle }
    })()
    state.stream = next
    observePromise(next, {
      rejected: () => {
        if (state.stream === next) state.stream = undefined
      },
    })
    return next
  }

  const runQueue = async () => {
    let includeFiles = true
    if (state.demo) {
      await state.demo.start()
    }

    const mod = await import("./runtime.queue")
    const createSession = input.createSession
    await mod.runPromptQueue({
      footer,
      initialInput: input.initialInput,
      onSend: (prompt) => {
        state.shown = true
        state.history.push(prompt)
      },
      onNewSession: createSession
        ? async () => {
            try {
              const created = await createSession(ctx, {
                agent: state.agent,
              })
              await footer.idle().catch((error) => log.debug("footer did not settle before new session", { error }))
              await state.stream
                ?.then((item) => item.handle.close())
                .catch((error) => log.warn("failed to close previous session transport", { error }))
              state.stream = undefined
              state.session = undefined
              state.selectSubagent = undefined
              state.shown = false
              state.sessionID = created.sessionID
              state.sessionTitle = created.sessionTitle
              state.agent = created.agent ?? state.agent
              state.history = []
              includeFiles = true
              state.demo = input.demo
                ? createRunDemo({
                    footer,
                    sessionID: state.sessionID,
                    thinking: input.thinking,
                    limits: () => state.limits,
                  })
                : undefined
              footer.event({
                type: "stream.subagent",
                state: {
                  tabs: [],
                  details: {},
                  questions: [],
                },
              })
              footer.event({ type: "stream.view", view: { type: "prompt" } })
              footer.event({
                type: "stream.patch",
                patch: {
                  phase: "idle",
                  duration: "",
                  startedAt: undefined,
                  usage: "",
                  first: true,
                },
              })
              footer.append({
                kind: "system",
                text: `new session ${state.sessionID}`,
                phase: "final",
                source: "system",
              })
              await state.demo?.start()
            } catch (error) {
              footer.event({
                type: "stream.patch",
                patch: {
                  phase: "idle",
                  status: "failed to start new session",
                },
              })
              footer.append({
                kind: "error",
                text: error instanceof Error ? error.message : String(error),
                phase: "start",
                source: "system",
              })
            }
          }
        : undefined,
      run: async (prompt, signal) => {
        if (state.demo && (await state.demo.prompt(prompt, signal))) {
          return
        }

        try {
          const next = await ensureStream()
          await next.handle.runPromptTurn({
            agent: state.agent,
            prompt,
            files: input.files,
            includeFiles,
            signal,
          })
          includeFiles = false
        } catch (error) {
          if (signal.aborted || footer.isClosed) {
            return
          }

          const text =
            (
              await state.stream
                ?.then((item) => item.mod)
                .catch((loadError) => {
                  log.debug("failed to load transport error formatter", { error: loadError })
                  return undefined
                })
            )?.formatUnknownError(error) ?? (error instanceof Error ? error.message : String(error))
          footer.append({ kind: "error", text, phase: "start", source: "system" })
        }
      },
    })
  }

  try {
    const eager = eagerStream(input, ctx)
    if (eager) {
      await ensureStream()
    }

    if (!eager && input.resolveSession) {
      queueMicrotask(() => {
        if (footer.isClosed) {
          return
        }

        observePromise(ensureStream(), {
          rejected: (error) => log.debug("session transport prewarm failed", { error }),
        })
      })
    }

    try {
      await runQueue()
    } finally {
      await state.stream
        ?.then((item) => item.handle.close())
        .catch((error) => log.warn("failed to close session transport", { error }))
    }
  } finally {
    const title = await resolveExitTitle(ctx, input, state)

    await shell.close({
      showExit: state.shown && hasSession(input, state),
      sessionTitle: title,
      sessionID: state.sessionID,
      history: state.history,
    })
  }
}

// Local in-process mode. Creates a client backed by a direct fetch to
// the in-process server, so no external HTTP server is needed.
export async function runInteractiveLocalMode(input: RunLocalInput): Promise<void> {
  const sdk = createLocalControlPlaneClient({ directory: input.directory })
  let session: Promise<ResolvedSession> | undefined

  return runInteractiveRuntime({
    files: input.files,
    system: input.system,
    workarea: input.workarea,
    initialInput: input.initialInput,
    thinking: input.thinking,
    replay: input.replay,
    replayLimit: input.replayLimit,
    demo: input.demo,
    resolveSession: () => {
      if (session) {
        return session
      }

      session = Promise.all([input.resolveAgent(), input.session(sdk)]).then(([agent, next]) => {
        if (!next?.id) {
          throw new Error("Session not found")
        }

        return {
          sessionID: next.id,
          sessionTitle: next.title,
          agent,
        }
      })
      return session
    },
    createSession: createSessionResolver(input.createSession),
    boot: async () => {
      return {
        sdk,
        directory: input.directory,
        sessionID: "",
        sessionTitle: undefined,
        resume: false,
        agent: input.agent,
      }
    },
  })
}

// Attach mode. Uses the caller-provided control-plane client directly.
export async function runInteractiveWorkflow(input: RunInput & { createSession?: CreateSession }): Promise<void> {
  return runInteractiveRuntime({
    files: input.files,
    system: input.system,
    workarea: input.workarea,
    initialInput: input.initialInput,
    thinking: input.thinking,
    replay: input.replay,
    replayLimit: input.replayLimit,
    demo: input.demo,
    boot: async () => ({
      sdk: input.sdk,
      directory: input.directory,
      sessionID: input.sessionID,
      sessionTitle: input.sessionTitle,
      resume: input.resume,
      agent: input.agent,
    }),
    createSession: createSessionResolver(input.createSession),
  })
}
