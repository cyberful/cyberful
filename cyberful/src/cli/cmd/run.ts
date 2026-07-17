// ── Run Command Orchestration ────────────────────────────────────
// Executes one-shot prompts, local interactive sessions, or attached sessions;
//   it also owns command dispatch, resumption, forking, and streamed output.
// → cyberful/src/cli/cmd/run/runtime.ts — hosts the direct interactive runtime.
// ─────────────────────────────────────────────────────────────────

import type { Argv } from "yargs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { ServerAuth } from "@/server/auth"
import { SubsystemPhase } from "@/subsystem/phase"
import { EOL } from "node:os"
import { Filesystem } from "@/util/filesystem"
import { createControlPlaneClient, type ControlPlaneClient, type ToolPart } from "@/server/client"
import { createLocalControlPlaneClient } from "@/server/client/local"
import { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { ensureWorkarea, requireWorkarea, setLastWorkarea, workareaSystemPrompt } from "@/workarea"
import { DockerPreflight } from "@/dependency/docker-preflight"
import * as Log from "@/util/log"

const runtimeTask = import("./run/runtime")
const log = Log.create({ service: "cli.run" })

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function isMemoryStatusMessage(message: string) {
  return /\bmemory\b|\bL0\b|\bL3\b/i.test(message)
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch (error) {
    log.debug("failed to render tool details; using the generic view", { error, tool: part.tool })
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch (error) {
    log.debug("failed to render tool error details; using the generic view", { error, tool: part.tool })
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run cyberful with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running cyberful server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to CYBERFUL_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to CYBERFUL_SERVER_USERNAME or 'cyberful')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("replay", {
        type: "boolean",
        default: false,
        describe: "replay visible session history on interactive resume",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
      })
      .option("workarea", {
        type: "string",
        describe: "store engagement artifacts under work/<workarea>/",
      })
      .option("demo", {
        type: "boolean",
        default: false,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const agentSvc = yield* Agent.Service
    const localInstance = yield* InstanceRef
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const thinking = args.interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (args.interactive && args.command) {
        die("--interactive cannot be used with --command")
      }

      if (args.demo && !args.interactive) {
        die("--demo requires --interactive")
      }

      if (args.interactive && args.format === "json") {
        die("--interactive cannot be used with --format json")
      }

      if (args.replay && !args.interactive) {
        die("--replay requires --interactive")
      }

      if (args["replay-limit"] !== undefined && !args.interactive) {
        die("--replay-limit requires --interactive")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (args.interactive && !process.stdout.isTTY) {
        die("--interactive requires a TTY stdout")
      }

      if (args.interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay || args["replay-limit"] !== undefined

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch (error) {
          log.warn("failed to change run directory", { error, directory: args.dir })
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const workarea = (() => {
        if (args.workarea === undefined) return undefined
        try {
          return requireWorkarea(args.workarea)
        } catch (error) {
          die(error instanceof Error ? error.message : "Invalid workarea.")
        }
      })()
      const workareaSystem = workarea ? workareaSystemPrompt(workarea) : undefined
      if (workarea) {
        if (!args.attach) {
          await ensureWorkarea(directory ?? root, workarea)
        }
        await setLastWorkarea(args.attach ? root : (directory ?? root), workarea).catch((error) => {
          log.warn("failed to persist the latest workarea", { error, workarea })
        })
      }
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        if (!args.attach) throw new Error("An attached control-plane URL is required")
        return createControlPlaneClient({
          baseUrl: args.attach,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

          files.push({
            type: "file",
            url: pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !args.interactive) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: ControlPlaneClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch((error) => {
              log.debug("failed to load requested session", { error, sessionID: args.session })
              return undefined
            })

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function createFreshSession(
        sdk: ControlPlaneClient,
        input: { agent: string | undefined },
      ): Promise<SessionInfo> {
        await DockerPreflight.requireDockerDaemon()
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: ControlPlaneClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch((error) => {
            log.debug("failed to resolve attached server directory", { error, server: args.attach })
            return undefined
          })
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        // A Codex-owned workflow kickoff (for example brief) does not resolve through the persona catalog.
        // Workflow-driven interception handles it before transport startup; direct mid-chain phase
        // launches remain an explicit headless opt-in.
        if (SubsystemPhase.workflowForKickoffAgent(name) || SubsystemPhase.workflowOf(name)) return name

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: ControlPlaneClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch((error) => {
            log.debug("failed to list attached server agents", { error, server: args.attach })
            return undefined
          })

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: ControlPlaneClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: ControlPlaneClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it to stdout/UI.
        async function loop(events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          let error: string | undefined

          for await (const event of events.stream) {
            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "busy"
            ) {
              const message = event.properties.status.message?.trim()
              if (message && isMemoryStatusMessage(message)) {
                if (emit("status", { status: event.properties.status })) continue
                const key = `status:${message}`
                if (toggles.get(key) !== true) {
                  if (process.stdout.isTTY) {
                    UI.empty()
                    UI.println(`${UI.Style.TEXT_DIM}${message}${UI.Style.TEXT_NORMAL}`)
                    UI.empty()
                  } else {
                    process.stdout.write(message + EOL)
                  }
                  toggles.set(key, true)
                }
              }
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle"
            ) {
              break
            }
          }
          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        if (!args.interactive) {
          const events = await client.event.subscribe()
          const operationAbort = new AbortController()
          let streamCloseTask: Promise<void> | undefined
          const closeEvents = () => {
            streamCloseTask ??= events.stream.return().then(() => undefined)
            return streamCloseTask
          }

          // ── One-Shot Runs Own Both Tasks ───────────────────────
          // A prompt or command produces its user-visible output on the subscribed
          // event stream while its HTTP request remains active. Both tasks must be
          // joined: a stream failure aborts the request, and a request failure closes
          // the stream. Normal completion waits for the session's idle event before
          // returning, so output cannot continue after command ownership ends.
          // ─────────────────────────────────────────────────────────────────
          const eventTask = loop(events).catch((error) => {
            operationAbort.abort(error)
            throw error
          })
          const operation = args.command
            ? client.session.command(
                {
                  sessionID,
                  agent,
                  command: args.command,
                  arguments: message,
                  system: workareaSystem,
                  workarea,
                },
                { signal: operationAbort.signal },
              )
            : client.session.prompt(
                {
                  sessionID,
                  agent,
                  system: workareaSystem,
                  workarea,
                  parts: [...files, { type: "text", text: message }],
                },
                { signal: operationAbort.signal },
              )
          const operationTask = operation.then(
            async (result) => {
              if (result.error) {
                await closeEvents().catch((error) =>
                  log.debug("failed to close event stream after request error", { error }),
                )
              }
              return result
            },
            async (error) => {
              await closeEvents().catch((closeError) =>
                log.debug("failed to close event stream after request failure", { error: closeError }),
              )
              throw error
            },
          )

          try {
            const [result, streamError] = await Promise.all([operationTask, eventTask])
            if (result.error) {
              if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
              process.exitCode = 1
            }
            if (streamError) process.exitCode = 1
          } finally {
            operationAbort.abort(new Error("non-interactive run complete"))
            await closeEvents().catch((error) => log.debug("failed to close non-interactive event stream", { error }))
            await Promise.allSettled([operationTask, eventTask])
          }
          return
        }

        const { runInteractiveWorkflow } = await runtimeTask
        try {
          await runInteractiveWorkflow({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            system: workareaSystem,
            workarea,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (args.interactive && !args.attach && !args.session && !args.continue) {
        const { runInteractiveLocalMode } = await runtimeTask

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            resolveAgent: localAgent,
            session,
            createSession: createFreshSession,
            agent: args.agent,
            system: workareaSystem,
            workarea,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const sdk = createLocalControlPlaneClient({ directory })
      await execute(sdk)
    })
  }),
})
