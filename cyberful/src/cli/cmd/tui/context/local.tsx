// ── Local TUI Selection State ────────────────────────────────────
// Derives visible workflows and agents from synchronized data, owns home-screen
//   selections and colors, and serializes pinned-session persistence through exit.
// ─────────────────────────────────────────────────────────────────

import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useRoute } from "@tui/context/route"
import { useEvent } from "@tui/context/event"
import path from "node:path"
import { Global } from "@/global"
import { iife } from "@/util/iife"
import { SubsystemPhase } from "@/subsystem/phase"
import { useToast } from "../ui/toast"
import { RGBA } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { useExit } from "./exit"
import * as Log from "@/util/log"
import { useKV } from "./kv"

const log = Log.create({ service: "tui.local" })
const WORKFLOW_PREFERENCE_KEY = "engagement_workflow"
type AgentThemeColor = "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"
const AgentThemeColors: ReadonlySet<string> = new Set([
  "primary",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
  "info",
])

function isAgentThemeColor(color: string): color is AgentThemeColor {
  return AgentThemeColors.has(color)
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const toast = useToast()
    const exit = useExit()
    const kv = useKV()

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const key = (candidate: { name: string; workflow?: string }) =>
        candidate.workflow ? `${candidate.workflow}/${candidate.name}` : candidate.name
      const [agentStore, setAgentStore] = createStore<{ current: string | undefined }>({ current: undefined })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((candidate) => key(candidate) === agentStore.current) ?? agents().at(0)
        },
        set(name: string, workflow?: string) {
          const matches = agents().filter(
            (candidate) => candidate.name === name && (workflow === undefined || candidate.workflow === workflow),
          )
          const match = matches.length === 1 ? matches[0] : undefined
          if (!match)
            return toast.show({
              variant: "warning",
              message: matches.length === 0 ? `Agent not found: ${name}` : `Agent is ambiguous: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", key(match))
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", key(value))
          })
        },
        color(name: string) {
          const current = this.current()
          const selected =
            current?.name === name ? current : visibleAgents().find((candidate) => candidate.name === name)
          const index = selected ? visibleAgents().findIndex((candidate) => key(candidate) === key(selected)) : -1
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            if (isAgentThemeColor(color)) return theme[color]
            log.warn("ignored invalid agent color", { agent: agent.name, color })
          }
          return colors()[index % colors().length]
        },
      }
    })

    // ── Engagement Workflow Is Chosen Before Session Ownership ────
    // A workflow names an atomic phase chain whose kickoff becomes a new session's
    // first agent. Workflows come from the static runtime registry rather than project
    // configuration, so selection cannot invent an unsupported chain. The choice
    // survives a TUI restart; otherwise a restarted Bug Bounty engagement silently
    // falls back to the first registry entry (Pentest) before creating its session.
    // Submission waits for KV readiness, so an auto-submitted launch prompt cannot
    // race the persisted selection. Cycling a single workflow remains a no-op.
    // ─────────────────────────────────────────────────────────────────
    const workflow = iife(() => {
      const workflows = SubsystemPhase.listWorkflows()
      const [workflowStore, setWorkflowStore] = createStore<{ current: string | undefined; ready: boolean }>({
        current: workflows[0]?.name,
        ready: false,
      })
      let selectedBeforeRestore = false

      const select = (name: string) => {
        if (!workflows.some((candidate) => candidate.name === name)) return
        selectedBeforeRestore = true
        setWorkflowStore("current", name)
        if (kv.ready) kv.set(WORKFLOW_PREFERENCE_KEY, name)
      }

      createEffect(() => {
        if (!kv.ready) return
        if (selectedBeforeRestore) {
          const selected = workflowStore.current
          if (selected) kv.set(WORKFLOW_PREFERENCE_KEY, selected)
          setWorkflowStore("ready", true)
          return
        }
        const persisted = kv.get(WORKFLOW_PREFERENCE_KEY)
        batch(() => {
          if (typeof persisted === "string" && workflows.some((candidate) => candidate.name === persisted))
            setWorkflowStore("current", persisted)
          setWorkflowStore("ready", true)
        })
      })

      return {
        get ready() {
          return workflowStore.ready
        },
        list() {
          return workflows
        },
        current() {
          return workflows.find((candidate) => candidate.name === workflowStore.current) ?? workflows[0]
        },
        set(name: string) {
          select(name)
        },
        move(direction: 1 | -1) {
          if (workflows.length === 0) return
          const cur = this.current()
          let next = workflows.findIndex((candidate) => candidate.name === cur?.name) + direction
          if (next < 0) next = workflows.length - 1
          if (next >= workflows.length) next = 0
          const name = workflows[next]?.name
          if (name) select(name)
        },
      }
    })

    const session = iife(() => {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(Global.Path.state, "session.json")
      const state = {
        pending: false,
      }
      let saveTail = Promise.resolve()

      // ── Pinned State Persists In User Order Before Exit ────────
      // Session events may change multiple quick slots in one render turn, while
      // initial state is still loading. Each save captures its own immutable list
      // and joins one serialized tail so an older write cannot win a race. The TUI
      // exit context waits for both initial load and that tail before destroying
      // providers, preserving the latest user-visible pin selection.
      // ─────────────────────────────────────────────────────────────────
      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        const pinned = [...sessionStore.pinned]
        saveTail = saveTail
          .then(() => Filesystem.writeJson(filePath, { pinned }))
          .catch((error) => log.warn("failed to save pinned sessions", { error, filePath }))
      }

      const loadTask = Filesystem.readJson(filePath)
        .then((value) => {
          if (!isRecord(value) || !Array.isArray(value.pinned)) return
          setSessionStore(
            "pinned",
            value.pinned.filter((sessionID): sessionID is string => typeof sessionID === "string"),
          )
        })
        .catch((error) => {
          if (isRecord(error) && error.code === "ENOENT") return
          log.warn("failed to read pinned sessions", { filePath, error })
        })
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })
      const removeExitFinalizer = exit.finalizer.add(async () => {
        await loadTask
        await saveTail
      })
      onCleanup(removeExitFinalizer)

      const route = useRoute()
      const event = useEvent()

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    })

    const result = {
      agent,
      workflow,
      session,
    }
    return result
  },
})
