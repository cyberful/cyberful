// ── Built-In TUI Slots ───────────────────────────────────────────
// Composes the small set of host-owned visual contributions and restores an
//   empty renderer when the TUI is disposed.
// ─────────────────────────────────────────────────────────────────

import type {
  TuiFeatureApi,
  TuiHostSlotMap,
  TuiSlotContext,
  TuiSlotContribution,
  TuiSlotMap,
  TuiSlotProps,
} from "@/cli/cmd/tui/api-types"
import { createSlot, createSolidSlotRegistry, type JSX } from "@opentui/solid"

type Slot = <Name extends keyof TuiHostSlotMap>(props: TuiSlotProps<Name>) => JSX.Element | null

export type HostFeatureApi = TuiFeatureApi
export type HostSlots = {
  register: (contribution: TuiSlotContribution) => () => void
  dispose: () => void
}

function empty<Name extends keyof TuiHostSlotMap>(_props: TuiSlotProps<Name>) {
  return null
}

let view: Slot = empty

export const Slot: Slot = (props) => view(props)

export function setupSlots(api: HostFeatureApi): HostSlots {
  const reg = createSolidSlotRegistry<TuiSlotMap, TuiSlotContext>(
    api.renderer,
    {
      theme: api.theme,
    },
    {
      onPluginError(event) {
        console.error("[tui.slot] contribution error", {
          contribution: event.pluginId,
          slot: event.slot,
          phase: event.phase,
          source: event.source,
          message: event.error.message,
        })
      },
    },
  )

  const slot = createSlot<TuiSlotMap, TuiSlotContext>(reg)
  view = (props) => slot(props as Parameters<typeof slot>[0])
  let sequence = 0
  return {
    register(contribution) {
      sequence += 1
      return reg.register({ ...contribution, id: `builtin:${sequence}` })
    },
    dispose() {
      view = empty
    },
  }
}
