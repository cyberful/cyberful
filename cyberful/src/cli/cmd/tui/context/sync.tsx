// ── TUI Control-Plane Projection ─────────────────────────────────
// Bootstraps project data in parallel and reduces live events into the sessions,
//   messages, parts, status, questions, tools, and phase feeds rendered by the TUI.
// ─────────────────────────────────────────────────────────────────

import type {
  Message,
  Agent,
  Session,
  Part,
  Config,
  Todo,
  Command,
  QuestionRequest,
  FormatterStatus,
  SessionStatus,
} from "@/server/client"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@/util/binary"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import * as Log from "@/util/log"
import path from "node:path"
import { useKV } from "./kv"
import { aggregateFailures } from "./aggregate-failures"
import { foldExpertActivity, type ExpertPhaseEntry } from "./expert-feed"

export type SkillFeedEntry = {
  id: string
  sessionID: string
  timestamp: number
  skills: string[]
}

// ── Phase Feed Reduction Stays Independent Of The TUI ────────────
// The pure feed fold merges streamed tool calls and results without depending on
// Solid or terminal state, which keeps its event-ordering contract directly testable.
// This projection imports that fold and re-exports its entry type so existing route
// consumers retain one stable boundary while rendering remains presentation-owned.
// → cyberful/src/cli/cmd/tui/context/expert-feed.ts — owns the pure reduction.
// ─────────────────────────────────────────────────────────────────
export type { ExpertPhaseEntry }

const EXPERT_PHASE_HISTORY_CAP = 200

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      agent: Agent[]
      command: Command[]
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      skill: {
        [sessionID: string]: SkillFeedEntry[]
      }
      expert_phase: {
        [sessionID: string]: ExpertPhaseEntry[]
      }
      expert_generated_tokens: {
        [sessionID: string]: number
      }
      // ── Activity Can Recover A Missing Phase Start ───────────────
      // This entry drives both the phase header and its generating or tool spinner.
      // Start creates it and end clears it, but the first progress, text, or tool
      // frame also initializes it because event delivery may omit start. Tokens
      // remain session-wide across process boundaries; `lastKind` selects the
      // current user-facing activity label.
      // ─────────────────────────────────────────────────────────────────
      expert_phase_running: {
        [sessionID: string]: { phase: string; tokens?: number; lastKind?: string } | undefined
      }
      part: {
        [messageID: string]: Part[]
      }
      formatter: FormatterStatus[]
    }>({
      config: {},
      status: "loading",
      agent: [],
      question: {},
      command: [],
      session: [],
      session_status: {},
      todo: {},
      message: {},
      skill: {},
      expert_phase: {},
      expert_generated_tokens: {},
      expert_phase_running: {},
      part: {},
      formatter: [],
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()

    const fullSyncedSessions = new Set<string>()

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function bySession<T extends { sessionID: string }>(items: T[]) {
      return items.reduce<Record<string, T[]>>((acc, item) => {
        acc[item.sessionID] = [...(acc[item.sessionID] ?? []), item]
        return acc
      }, {})
    }

    function timestampMillis(value: unknown) {
      if (typeof value === "number" && Number.isFinite(value)) return value
      if (typeof value === "string") {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) return numeric
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
      return Date.now()
    }

    function stringArray(value: unknown) {
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    }

    function skillEntry(message: Message): SkillFeedEntry | undefined {
      if (message.role !== "user" || message.metadata?.synthetic !== true) return
      const skills = stringArray(message.metadata.skill_autoload)
      if (skills.length === 0) return
      return {
        id: message.id,
        sessionID: message.sessionID,
        timestamp: message.time.created,
        skills,
      }
    }

    function mergeSkills(existing: SkillFeedEntry[], next: SkillFeedEntry[]) {
      const byID = new Map(existing.map((item) => [item.id, item]))
      next.forEach((item) => byID.set(item.id, item))
      return dedupeSkills([...byID.values()])
    }

    function dedupeSkills(skills: SkillFeedEntry[]) {
      const seen = new Set<string>()
      return skills
        .toSorted((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
        .filter((item) => {
          const key = [item.sessionID, item.timestamp, item.skills.join(",")].join("\0")
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event) => {
      switch (event.type) {
        case "server.instance.disposed":
          requestBootstrap()
          break
        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "session.next.skill.learned": {
          const skill = {
            id: event.id,
            sessionID: event.properties.sessionID,
            timestamp: timestampMillis(event.properties.timestamp),
            skills: [...event.properties.skills],
          }
          if (!store.skill[skill.sessionID]) {
            setStore("skill", skill.sessionID, [skill])
            break
          }
          setStore(
            "skill",
            skill.sessionID,
            produce((draft) => {
              const existing = draft.findIndex((item) => item.id === skill.id)
              if (existing >= 0) {
                draft[existing] = skill
                return
              }
              draft.push(skill)
              draft.splice(0, draft.length, ...dedupeSkills(draft))
            }),
          )
          break
        }
        case "session.next.subsystem.phase_activity": {
          const activity = event.properties
          // ── Phase Activity Has Transient And Durable Projections ───
          // Start and end frames own only the live header and spinner, while progress
          // updates the session token total without adding a feed row. Text, tool,
          // output, actor-lifecycle, and status frames enter the durable feed through
          // one pure fold.
          // Non-terminal activity may recover a missed start frame, but a terminal
          // status cannot resurrect state after an end frame has already cleared it.
          // Folding precedes the history cap so a result can update its existing call.
          // ─────────────────────────────────────────────────────────────────
          if (activity.kind === "start") {
            setStore("expert_phase_running", activity.sessionID, {
              phase: activity.phase,
              tokens: store.expert_generated_tokens[activity.sessionID],
            })
            break
          }
          if (activity.kind === "end") {
            setStore("expert_phase_running", activity.sessionID, undefined)
            break
          }
          if (activity.kind === "progress") {
            const tokens = Number(activity.text) || 0
            const sessionTokens = Math.max(store.expert_generated_tokens[activity.sessionID] ?? 0, tokens)
            setStore("expert_generated_tokens", activity.sessionID, sessionTokens)
            setStore("expert_phase_running", activity.sessionID, (prev) =>
              prev
                ? { ...prev, tokens: Math.max(prev.tokens ?? 0, sessionTokens) }
                : { phase: activity.phase, tokens: sessionTokens },
            )
            break
          }
          if (activity.kind !== "status")
            setStore("expert_phase_running", activity.sessionID, (prev) =>
              prev
                ? { ...prev, phase: activity.phase, lastKind: activity.kind }
                : {
                    phase: activity.phase,
                    tokens: store.expert_generated_tokens[activity.sessionID],
                    lastKind: activity.kind,
                  },
            )
          const sid = activity.sessionID
          const folded = foldExpertActivity(store.expert_phase[sid] ?? [], {
            id: event.id,
            sessionID: sid,
            timestamp: timestampMillis(activity.timestamp),
            phase: activity.phase,
            subsystem: activity.subsystem,
            kind:
              activity.kind === "tool"
                ? "tool"
                : activity.kind === "output"
                  ? "output"
                  : activity.kind === "agent"
                    ? "agent"
                    : activity.kind === "status"
                      ? "status"
                      : "text",
            text: activity.text,
            tool: activity.tool,
            actor: activity.actor,
            actorState: activity.actorState,
            actorTransitionID: activity.actorTransitionID,
          })
          const capped =
            folded.length > EXPERT_PHASE_HISTORY_CAP ? folded.slice(folded.length - EXPERT_PHASE_HISTORY_CAP) : folded
          if (!store.expert_phase[sid]) setStore("expert_phase", sid, capped)
          else setStore("expert_phase", sid, reconcile(capped))
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          if (event.properties.field !== "text") break
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              if (part.type !== "text" && part.type !== "reasoning") return
              part.text =
                event.properties.mode === "replace" ? event.properties.delta : part.text + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()
    let bootstrapTail = Promise.resolve()
    let disposed = false

    async function performBootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      try {
        const projectPromise = project.sync()
        const sessionListPromise = projectPromise.then(() => listSessions())
        const agentsPromise = sdk.client.app.agents({}, { throwOnError: true })
        const configPromise = sdk.client.config.get({}, { throwOnError: true })
        const blockingRequests: { name: string; promise: Promise<unknown> }[] = [
          { name: "app.agents", promise: agentsPromise },
          { name: "config.get", promise: configPromise },
          { name: "project.sync", promise: projectPromise },
          ...(args.continue ? [{ name: "session.list", promise: sessionListPromise }] : []),
        ]
        const settled = await Promise.allSettled(blockingRequests.map((request) => request.promise))
        const failure = aggregateFailures(
          blockingRequests.map((request, index) => ({ name: request.name, result: settled[index] })),
        )
        if (failure) throw failure

        const agents = (await agentsPromise).data ?? []
        const config = (await configPromise).data
        if (!config) throw new Error("config.get returned no configuration")
        const sessions = args.continue ? await sessionListPromise : undefined
        if (disposed) return
        batch(() => {
          setStore("agent", reconcile(agents))
          setStore("config", reconcile(config))
          if (sessions !== undefined) setStore("session", reconcile(sessions))
        })

        if (store.status !== "complete") setStore("status", "partial")
        try {
          const [sessionList, commands, questions, formatters, statuses] = await Promise.all([
            args.continue ? Promise.resolve(undefined) : sessionListPromise,
            sdk.client.command.list(),
            sdk.client.question.list(),
            sdk.client.formatter.status(),
            sdk.client.session.status(),
          ])
          if (disposed) return
          batch(() => {
            if (sessionList) setStore("session", reconcile(sessionList))
            setStore("command", reconcile(commands.data ?? []))
            setStore("question", reconcile(bySession(questions.data ?? [])))
            setStore("formatter", reconcile(formatters.data ?? []))
            setStore("session_status", reconcile(statuses.data ?? {}))
            setStore("status", "complete")
          })
        } catch (error) {
          Log.Default.warn("non-blocking TUI bootstrap failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } catch (error) {
        Log.Default.error("tui bootstrap failed", {
          error: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        })
        if (fatal) {
          await exit(error)
        } else {
          throw error
        }
      }
    }

    // ── Bootstrap Snapshots Apply In Request Order ──────────────────
    // Mount and instance-disposal events may request complete snapshots while a
    // previous bootstrap is still reading. One promise tail serializes those
    // snapshots so older responses cannot overwrite newer instance state. The
    // tail observes failure and remains reusable; direct callers still receive
    // their own task and may decide whether a refresh failure is fatal.
    // ─────────────────────────────────────────────────────────────────
    function bootstrap(input: { fatal?: boolean } = {}) {
      if (disposed) return Promise.resolve()
      const task = bootstrapTail.then(() => (disposed ? undefined : performBootstrap(input)))
      bootstrapTail = task.catch((error) => {
        Log.Default.warn("queued TUI bootstrap failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return task
    }

    function requestBootstrap() {
      bootstrap()
    }

    onMount(requestBootstrap)

    onCleanup(() => {
      disposed = true
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.CYBERFUL_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        // ── Route Sync Cannot Outlive Its Session View ───────────
        // Opening a session starts three independent control-plane reads before
        // publishing one coherent store update. The route owns their shared abort
        // signal and cancels it when navigation changes. A final abort check after
        // all reads prevents a late response from repopulating the abandoned view
        // or marking an incomplete session as fully synchronized.
        // ─────────────────────────────────────────────────────────────────
        async sync(sessionID: string, options: { signal?: AbortSignal } = {}) {
          if (fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true, signal: options.signal }),
            sdk.client.session.messages({ sessionID, limit: 100 }, { signal: options.signal }),
            sdk.client.session.todo({ sessionID }, { signal: options.signal }),
          ])
          options.signal?.throwIfAborted()
          const sessionData = session.data
          if (!sessionData) throw new Error(`session.get returned no session for ${sessionID}`)
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = sessionData
              if (!match.found) draft.session.splice(match.index, 0, sessionData)
              draft.todo[sessionID] = todo.data ?? []
              const infos: (typeof draft.message)[string] = []
              const skillEntries: SkillFeedEntry[] = []
              for (const message of messages.data ?? []) {
                infos.push(message.info)
                draft.part[message.info.id] = message.parts
                const skill = skillEntry(message.info)
                if (skill) skillEntries.push(skill)
              }
              draft.message[sessionID] = infos
              draft.skill[sessionID] = mergeSkills(draft.skill[sessionID] ?? [], skillEntries)
            }),
          )
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
