// ── Built-In TUI Contract ───────────────────────────────────────
// Freezes the direct-wired commands, route, event listeners, and visual slots
//   that replaced the former plugin-shaped runtime.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { TuiFeatureApi, TuiSlotContribution } from "@/cli/cmd/tui/api-types"
import { builtinTuiCapabilityIDs } from "./builtins"
import { installHomeFooter } from "../features/home/footer"
import { installNotifications } from "../features/system/notifications"
import { installWhichKey } from "../features/system/which-key"
import { installDiffViewer } from "../features/system/diff-viewer"

describe("built-in TUI capabilities", () => {
  test("register the stable command, route, event, and slot surface", () => {
    const commands: string[] = []
    const routes: string[] = []
    const events: string[] = []
    const slots: string[] = []
    const disposed: string[] = []

    const api = {
      kv: {
        get(_key: string, fallback: unknown) {
          return fallback
        },
        set() {},
      },
      tuiConfig: {
        diff_style: "auto",
        keybinds: {
          gather() {
            return []
          },
        },
      },
      keymap: {
        registerLayer(layer: { commands?: { name: string }[] }) {
          commands.push(...(layer.commands ?? []).map((command) => command.name))
          return () => disposed.push(`commands:${layer.commands?.map((command) => command.name).join(",")}`)
        },
      },
      route: {
        register(input: { name: string }[]) {
          routes.push(...input.map((route) => route.name))
          return () => disposed.push(`routes:${input.map((route) => route.name).join(",")}`)
        },
      },
      event: {
        on(type: string) {
          events.push(type)
          return () => disposed.push(`event:${type}`)
        },
      },
      slots: {
        register(contribution: TuiSlotContribution) {
          const names = Object.keys(contribution.slots)
          slots.push(...names)
          return () => disposed.push(`slots:${names.join(",")}`)
        },
      },
    } as unknown as TuiFeatureApi

    const off = [
      installHomeFooter(api),
      installNotifications(api),
      installWhichKey(api),
      installDiffViewer(api),
    ]

    expect(builtinTuiCapabilityIDs).toEqual(["home-footer", "notifications", "which-key", "diff-viewer"])
    expect(commands).toEqual([
      "which-key.toggle",
      "which-key.layout.toggle",
      "which-key.pending.toggle",
      "diff.open",
    ])
    expect(routes).toEqual(["diff"])
    expect(events).toEqual([
      "question.asked",
      "question.replied",
      "question.rejected",
      "session.status",
      "session.error",
    ])
    expect(slots).toEqual(["home_footer", "home_bottom", "app", "app_bottom"])

    for (const dispose of off.reverse()) dispose()
    expect(disposed).toHaveLength(10)
  })
})
