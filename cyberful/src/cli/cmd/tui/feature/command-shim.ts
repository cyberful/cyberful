// ── Legacy Feature Command Compatibility ────────────────────────
// Adapts the legacy command and dialog API onto current keymap commands and
// emits one actionable deprecation warning per legacy operation.
// → cyberful/src/cli/cmd/tui/api-types.ts — declares the compatibility surface.
// ─────────────────────────────────────────────────────────────────

import type { TuiCommand, TuiFeatureApi } from "@/cli/cmd/tui/api-types"
import { TuiKeybind } from "../config/keybind"
import type { DialogContext } from "../ui/dialog"

const COMMAND_PALETTE_SHOW = "command.palette.show"
const warned = new Set<string>()

type Warn = (api: string, replacement: string) => void
type LegacyDialog = TuiFeatureApi["ui"]["dialog"]
type CommandShimDialog = DialogContext | LegacyDialog
type LegacyKeybinds = TuiFeatureApi["tuiConfig"]["keybinds"]

function warnCommandShim(api: string, replacement: string) {
  console.warn("[tui.feature] deprecated TUI plugin API", { api, replacement })
}

function createCommandShimDialog(dialog: CommandShimDialog): LegacyDialog {
  if (!("stack" in dialog)) return dialog
  return {
    replace(render, onClose) {
      dialog.replace(render, onClose)
    },
    clear() {
      dialog.clear()
    },
    setSize(size) {
      dialog.setSize(size)
    },
    get size() {
      return dialog.size
    },
    get depth() {
      return dialog.stack.length
    },
    get open() {
      return dialog.stack.length > 0
    },
  }
}

function warnOnce(api: string, replacement: string, warn: Warn) {
  if (warned.has(api)) return
  warned.add(api)
  warn(api, replacement)
}

function toCommand(item: TuiCommand, dialog: LegacyDialog) {
  return {
    namespace: "palette",
    name: item.value,
    title: item.title,
    desc: item.description,
    category: item.category,
    suggested: item.suggested,
    hidden: item.hidden,
    enabled: item.enabled,
    slashName: item.slash?.name,
    slashAliases: item.slash?.aliases,
    run() {
      return item.onSelect?.(dialog)
    },
  }
}

function toBindings(commands: TuiCommand[], keybinds: LegacyKeybinds) {
  return commands.flatMap((item) =>
    item.keybind
      ? keybinds.has(commandName(item.keybind))
        ? keybinds
            .get(commandName(item.keybind))
            .map((binding) => ({ ...binding, cmd: item.value, desc: binding.desc ?? item.title }))
        : [
            {
              key: item.keybind,
              cmd: item.value,
              desc: item.title,
            },
          ]
      : [],
  )
}

function commandName(keybind: string) {
  const value: unknown = Object.hasOwn(TuiKeybind.CommandMap, keybind)
    ? Reflect.get(TuiKeybind.CommandMap, keybind)
    : undefined
  return typeof value === "string" ? value : keybind
}

export function createCommandShim(
  keymap: TuiFeatureApi["keymap"],
  dialog: CommandShimDialog,
  keybinds: LegacyKeybinds,
): TuiFeatureApi["command"] {
  const shimDialog = createCommandShimDialog(dialog)
  return {
    register(cb) {
      warnOnce("api.command.register", "api.keymap.registerLayer({ commands, bindings })", warnCommandShim)
      const commands = cb()
      return keymap.registerLayer({
        commands: commands.map((item) => toCommand(item, shimDialog)),
        bindings: toBindings(commands, keybinds),
      })
    },
    trigger(value) {
      warnOnce("api.command.trigger", "api.keymap.dispatchCommand(name)", warnCommandShim)
      keymap.dispatchCommand(value)
    },
    show() {
      warnOnce("api.command.show", `api.keymap.dispatchCommand("${COMMAND_PALETTE_SHOW}")`, warnCommandShim)
      keymap.dispatchCommand(COMMAND_PALETTE_SHOW)
    },
  }
}
