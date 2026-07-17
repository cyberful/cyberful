// ── TUI Feature API Adapter ──────────────────────────────────────
// Projects internal contexts into the stable feature surface for routes, slots,
//   dialogs, commands, state, the fixed palette, preferences, events, and cleanup.
// ─────────────────────────────────────────────────────────────────

import type { TuiDialogSelectOption, TuiFeatureApi, TuiRouteDefinition, TuiSlotProps } from "@/cli/cmd/tui/api-types"
import type { useEvent } from "@tui/context/event"
import type { useRoute } from "@tui/context/route"
import type { useSDK } from "@tui/context/sdk"
import type { useSync } from "@tui/context/sync"
import type { useTheme } from "@tui/context/theme"
import { Dialog as DialogUI, type useDialog } from "@tui/ui/dialog"
import type { TuiConfig } from "@/cli/cmd/tui/config/tui"
import type { useCyberfulKeymap } from "../keymap"
import type { useKV } from "../context/kv"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption as SelectOption } from "../ui/dialog-select"
import { Prompt } from "../component/prompt"
import { Slot as HostSlot } from "./slots"
import type { useToast } from "../ui/toast"
import { InstallationVersion } from "@/installation/version"
import * as Keymap from "../keymap"
import { createCommandShim } from "./command-shim"

type RouteEntry = {
  key: symbol
  render: TuiRouteDefinition["render"]
}

export type RouteMap = Map<string, RouteEntry[]>

type Input = {
  tuiConfig: TuiConfig.Resolved
  dialog: ReturnType<typeof useDialog>
  keymap: ReturnType<typeof useCyberfulKeymap>
  kv: ReturnType<typeof useKV>
  route: ReturnType<typeof useRoute>
  routes: RouteMap
  bump: () => void
  event: ReturnType<typeof useEvent>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  theme: ReturnType<typeof useTheme>
  toast: ReturnType<typeof useToast>
  renderer: TuiFeatureApi["renderer"]
  attention: TuiFeatureApi["attention"]
}

function routeRegister(routes: RouteMap, list: TuiRouteDefinition[], bump: () => void) {
  const key = Symbol()
  for (const item of list) {
    const prev = routes.get(item.name) ?? []
    prev.push({ key, render: item.render })
    routes.set(item.name, prev)
  }
  bump()

  return () => {
    for (const item of list) {
      const prev = routes.get(item.name)
      if (!prev) continue
      const next = prev.filter((x) => x.key !== key)
      if (!next.length) {
        routes.delete(item.name)
        continue
      }
      routes.set(item.name, next)
    }
    bump()
  }
}

function routeNavigate(route: ReturnType<typeof useRoute>, name: string, params?: Record<string, unknown>) {
  if (name === "home") {
    route.navigate({ type: "home" })
    return
  }

  if (name === "session") {
    const sessionID = params?.sessionID
    if (typeof sessionID !== "string") return
    route.navigate({ type: "session", sessionID })
    return
  }

  route.navigate({ type: "feature", id: name, data: params })
}

function routeCurrent(route: ReturnType<typeof useRoute>): TuiFeatureApi["route"]["current"] {
  if (route.data.type === "home") return { name: "home" }
  if (route.data.type === "session") {
    return {
      name: "session",
      params: {
        sessionID: route.data.sessionID,
        prompt: route.data.prompt,
      },
    }
  }

  return {
    name: route.data.id,
    params: route.data.data,
  }
}

function mapOption<Value>(item: TuiDialogSelectOption<Value>): SelectOption<Value> {
  return {
    ...item,
    onSelect: () => item.onSelect?.(),
  }
}

function pickOption<Value>(item: SelectOption<Value>): TuiDialogSelectOption<Value> {
  return {
    title: item.title,
    value: item.value,
    description: item.description,
    footer: item.footer,
    category: item.category,
    disabled: item.disabled,
  }
}

function mapOptionCb<Value>(cb?: (item: TuiDialogSelectOption<Value>) => void) {
  if (!cb) return
  return (item: SelectOption<Value>) => cb(pickOption(item))
}

function stateApi(sync: ReturnType<typeof useSync>): TuiFeatureApi["state"] {
  return {
    get ready() {
      return sync.ready
    },
    get config() {
      return sync.data.config
    },
    get path() {
      return sync.path
    },
    get vcs() {
      return undefined
    },
    session: {
      count() {
        return sync.data.session.length
      },
      get(sessionID) {
        return sync.session.get(sessionID)
      },
      diff() {
        return []
      },
      todo(sessionID) {
        return sync.data.todo[sessionID] ?? []
      },
      messages(sessionID) {
        return sync.data.message[sessionID] ?? []
      },
      status(sessionID) {
        return sync.data.session_status[sessionID]
      },
      question(sessionID) {
        return sync.data.question[sessionID] ?? []
      },
    },
    part(messageID) {
      return sync.data.part[messageID] ?? []
    },
  }
}

function appApi(): TuiFeatureApi["app"] {
  return {
    get version() {
      return InstallationVersion
    },
  }
}

export function createTuiApi(input: Input): TuiFeatureApi {
  const lifecycle: TuiFeatureApi["lifecycle"] = {
    signal: new AbortController().signal,
    onDispose() {
      return () => {}
    },
  }
  return {
    app: appApi(),
    attention: input.attention,
    command: createCommandShim(input.keymap, input.dialog, input.tuiConfig.keybinds),
    keys: {
      formatSequence(parts) {
        return Keymap.formatKeySequence(parts, input.tuiConfig)
      },
      formatBindings(bindings) {
        return Keymap.formatKeyBindings(bindings, input.tuiConfig)
      },
    },
    keymap: input.keymap,
    mode: {
      current() {
        return Keymap.getCyberfulModeStack(input.keymap).current()
      },
      push(mode) {
        return Keymap.getCyberfulModeStack(input.keymap).push(mode)
      },
    },
    route: {
      register(list) {
        return routeRegister(input.routes, list, input.bump)
      },
      navigate(name, params) {
        routeNavigate(input.route, name, params)
      },
      get current() {
        return routeCurrent(input.route)
      },
    },
    ui: {
      Dialog(props) {
        return (
          <DialogUI size={props.size} onClose={props.onClose}>
            {props.children}
          </DialogUI>
        )
      },
      DialogAlert(props) {
        return <DialogAlert {...props} />
      },
      DialogConfirm(props) {
        return <DialogConfirm {...props} />
      },
      DialogPrompt(props) {
        return <DialogPrompt {...props} description={props.description} />
      },
      DialogSelect(props) {
        return (
          <DialogSelect
            title={props.title}
            placeholder={props.placeholder}
            options={props.options.map(mapOption)}
            flat={props.flat}
            onMove={mapOptionCb(props.onMove)}
            onFilter={props.onFilter}
            onSelect={mapOptionCb(props.onSelect)}
            skipFilter={props.skipFilter}
            current={props.current}
          />
        )
      },
      Slot<Name extends string>(props: TuiSlotProps<Name>) {
        return <HostSlot {...props} />
      },
      Prompt(props) {
        return (
          <Prompt
            sessionID={props.sessionID}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.onSubmit}
            ref={props.ref}
            hint={props.hint}
            right={props.right}
            showPlaceholder={props.showPlaceholder}
            placeholders={props.placeholders}
          />
        )
      },
      toast(inputToast) {
        input.toast.show({
          title: inputToast.title,
          message: inputToast.message,
          variant: inputToast.variant ?? "info",
          duration: inputToast.duration,
        })
      },
      dialog: {
        replace(render, onClose) {
          input.dialog.replace(render, onClose)
        },
        clear() {
          input.dialog.clear()
        },
        setSize(size) {
          input.dialog.setSize(size)
        },
        get size() {
          return input.dialog.size
        },
        get depth() {
          return input.dialog.stack.length
        },
        get open() {
          return input.dialog.stack.length > 0
        },
      },
    },
    get tuiConfig() {
      return input.tuiConfig
    },
    kv: {
      get: input.kv.get,
      set(key, value) {
        input.kv.set(key, value)
      },
      get ready() {
        return input.kv.ready
      },
    },
    state: stateApi(input.sync),
    get client() {
      return input.sdk.client
    },
    event: input.event,
    renderer: input.renderer,
    slots: {
      register() {
        throw new Error("slots.register is only available in feature context")
      },
    },
    lifecycle,
    theme: {
      get current() {
        return input.theme.theme
      },
      mode() {
        return input.theme.mode()
      },
      get ready() {
        return input.theme.ready
      },
    },
  }
}
