// ── Interactive Runtime Boot Data ────────────────────────────────
// Resolves independent keybinding, diff-style, and session-history inputs before
//   the first frame, reusing only the currently pending configuration read.
// ─────────────────────────────────────────────────────────────────

import { Context, Effect, Layer } from "effect"
import { stringifyKeyStroke } from "@opentui/keymap"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { TuiKeybind } from "@/cli/cmd/tui/config/keybind"
import { makeRuntime } from "@/effect/run-service"
import { reusePendingTask } from "./runtime.shared"
import { resolveSession, sessionHistory } from "./session.shared"
import type { FooterKeybinds, RunDiffStyle, RunInput, RunPrompt } from "./types"
import * as Log from "@/util/log"

const log = Log.create({ service: "run.boot" })

const DEFAULT_KEYBINDS: FooterKeybinds = {
  leader: TuiKeybind.LeaderDefault,
  leaderTimeout: 2000,
  commandList: [{ key: "ctrl+p" }],
  interrupt: [{ key: "escape" }],
  historyPrevious: [{ key: "up" }],
  historyNext: [{ key: "down" }],
  inputClear: [{ key: "ctrl+c" }],
  inputSubmit: [{ key: "return" }],
  inputNewline: [{ key: "shift+return,ctrl+return,alt+return,ctrl+j" }],
}

export type SessionInfo = {
  first: boolean
  history: RunPrompt[]
}

type Config = Awaited<ReturnType<typeof TuiConfig.get>>
type BootService = {
  readonly resolveSessionInfo: (sdk: RunInput["sdk"], sessionID: string) => Effect.Effect<SessionInfo>
  readonly resolveFooterKeybinds: () => Effect.Effect<FooterKeybinds>
  readonly resolveDiffStyle: () => Effect.Effect<RunDiffStyle>
}

const configTask: { current?: Promise<Config> } = {}

class Service extends Context.Service<Service, BootService>()("@cyberful/RunBoot") {}

function loadConfig() {
  return reusePendingTask(configTask, () => TuiConfig.get())
}

function emptySessionInfo(): SessionInfo {
  return {
    first: true,
    history: [],
  }
}

function leaderKey(config: Config) {
  const key = config.keybinds.get("leader")?.[0]?.key
  if (!key) return TuiKeybind.LeaderDefault
  return typeof key === "string" ? key : stringifyKeyStroke(key)
}

function footerKeybinds(config: Config | undefined): FooterKeybinds {
  if (!config) {
    return DEFAULT_KEYBINDS
  }

  return {
    leader: leaderKey(config),
    leaderTimeout: config.leader_timeout,
    commandList: config.keybinds.get("command.palette.show"),
    interrupt: config.keybinds.get("session.interrupt"),
    historyPrevious: config.keybinds.get("prompt.history.previous"),
    historyNext: config.keybinds.get("prompt.history.next"),
    inputClear: config.keybinds.get("prompt.clear"),
    inputSubmit: config.keybinds.get("input.submit"),
    inputNewline: config.keybinds.get("input.newline"),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = Effect.fn("RunBoot.config")(() =>
      Effect.promise(() =>
        loadConfig().catch((error) => {
          log.debug("failed to load interactive configuration; using defaults", { error })
          return undefined
        }),
      ),
    )

    const resolveSessionInfo = Effect.fn("RunBoot.resolveSessionInfo")(function* (
      sdk: RunInput["sdk"],
      sessionID: string,
    ) {
      const session = yield* Effect.promise(() =>
        resolveSession(sdk, sessionID).catch((error) => {
          log.debug("failed to load interactive session history", { error, sessionID })
          return undefined
        }),
      )
      if (!session) {
        return emptySessionInfo()
      }

      return {
        first: session.first,
        history: sessionHistory(session),
      }
    })

    const resolveFooterKeybinds = Effect.fn("RunBoot.resolveFooterKeybinds")(function* () {
      return footerKeybinds(yield* config())
    })

    const resolveDiffStyle = Effect.fn("RunBoot.resolveDiffStyle")(function* () {
      return (yield* config())?.diff_style ?? "auto"
    })

    return Service.of({
      resolveSessionInfo,
      resolveFooterKeybinds,
      resolveDiffStyle,
    })
  }),
)

const runtime = makeRuntime(Service, layer)

// Fetches session messages to determine if this is the first turn and build prompt history.
export async function resolveSessionInfo(sdk: RunInput["sdk"], sessionID: string): Promise<SessionInfo> {
  return runtime
    .runPromise((svc) => svc.resolveSessionInfo(sdk, sessionID))
    .catch((error) => {
      log.debug("failed to resolve interactive session boot data", { error, sessionID })
      return emptySessionInfo()
    })
}

// Reads keybind overrides from TUI config and merges them with defaults.
export async function resolveFooterKeybinds(): Promise<FooterKeybinds> {
  return runtime
    .runPromise((svc) => svc.resolveFooterKeybinds())
    .catch((error) => {
      log.debug("failed to resolve interactive keybindings", { error })
      return DEFAULT_KEYBINDS
    })
}

export async function resolveDiffStyle(): Promise<RunDiffStyle> {
  return runtime
    .runPromise((svc) => svc.resolveDiffStyle())
    .catch((error) => {
      log.debug("failed to resolve interactive diff style", { error })
      return "auto"
    })
}
