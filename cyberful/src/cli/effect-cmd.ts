// ── Effect-Backed CLI Commands ───────────────────────────────────
// Adapts yargs commands to the application Effect runtime, supplies an
//   optional project instance, and guarantees disposal after each invocation.
// → cyberful/src/effect/app-runtime.ts — executes handlers with application services.
// ─────────────────────────────────────────────────────────────────

import type { Argv } from "yargs"
import { Effect, Schema } from "effect"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { cmd, type WithDoubleDash } from "./cmd/cmd"

/**
 * User-visible command failure. Throw via `fail("...")` from an effectCmd handler
 * to surface a printed message + non-zero exit. Recognised by the global error
 * formatter in `src/cli/error.ts` (FormatError), so the existing top-level
 * catch + cleanup in `src/index.ts` runs normally.
 */
export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
}) {}

export const fail = (message: string, exitCode = 1) => Effect.fail(new CliError({ message, exitCode }))

interface EffectCmdOpts<Args, A> {
  command: string | readonly string[]
  aliases?: string | readonly string[]
  describe: string | false
  builder?: (yargs: Argv) => Argv<Args>
  /**
   * Whether the command needs a project InstanceContext. Defaults to true.
   *
   * `true` (default): wraps the handler in `InstanceStore.Service.provide({directory})`
   * so `InstanceRef` resolves to a loaded `InstanceContext`. Auto-disposes via
   * `Effect.ensuring(store.dispose(ctx))` on every Exit (matches the legacy
   * `bootstrap()` finally-disposal). Runs InstanceBootstrap (config + plugin
   * init + File/etc forks) eagerly.
   *
   * `false`: skip the instance entirely. Saves the InstanceBootstrap work and
   * suppresses the `server.instance.disposed` IPC event. The handler runs
   * directly under AppRuntime — it can yield any `AppServices` but must not
   * yield `InstanceRef` (it'd be undefined, causing a defect).
   *
   * Function form: `(args) => boolean` decides per-invocation. Useful for
   * commands like `run --attach <url>` where one flag flips between local
   * (needs instance) and remote (doesn't).
   *
   * Use `false` for commands that don't read project state.
   */
  instance?: boolean | ((args: Args) => boolean)
  /** Defaults to process.cwd(). Override for commands that take a directory positional. */
  directory?: (args: Args) => string
  handler: (args: WithDoubleDash<Args>) => Effect.Effect<A, CliError, AppServices | InstanceStore.Service>
}

// ── Command Scope Owns Its Project Instance ──────────────────────
// Yargs validates and normalizes input with the supplied builder before invoking
// this adapter, but its generic wrapper erases the builder and retained `--` shape.
// The two boundary assertions restore only those builder-established types. Instance
// commands then load one scoped context and dispose it on success, typed failure,
// defect, or interruption; top-level CLI code remains the sole error renderer.
// ─────────────────────────────────────────────────────────────────
export const effectCmd = <Args, A>(opts: EffectCmdOpts<Args, A>) =>
  cmd<{}, Args>({
    command: opts.command,
    aliases: opts.aliases,
    describe: opts.describe,
    builder: opts.builder as never,
    async handler(rawArgs) {
      const args = rawArgs as unknown as WithDoubleDash<Args>
      const useInstance = typeof opts.instance === "function" ? opts.instance(args) : opts.instance !== false
      if (!useInstance) {
        await AppRuntime.runPromise(opts.handler(args))
        return
      }
      const directory = opts.directory?.(args) ?? process.cwd()
      const { store, ctx } = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) => store.load({ directory }).pipe(Effect.map((ctx) => ({ store, ctx })))),
      )
      try {
        await AppRuntime.runPromise(opts.handler(args).pipe(Effect.provideService(InstanceRef, ctx)))
      } finally {
        await AppRuntime.runPromise(store.dispose(ctx))
      }
    },
  })
