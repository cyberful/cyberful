// ── Cyberful Process Entrypoint ──────────────────────────────────
// Boots environment and installed assets, dispatches the gateway or CLI command,
// renders fatal errors, and reaps every process and container owner before exit.
// → cyberful/src/bootstrap-env.ts — layers environment before import-time readers.
// → cyberful/src/bootstrap-config.ts — selects or materializes first-party configuration.
// → cyberful/src/bootstrap-browser.ts — prepares the embedded browser driver for releases.
// @docs/concepts/architecture.md
// ─────────────────────────────────────────────────────────────────

// ── Environment Bootstrap Must Evaluate First ────────────────────
// Global path and configuration modules read environment values during module
// evaluation, including through transitive imports below. bootstrap-env therefore
// remains the first dependency so baked and working-directory values are layered
// before those readers execute. Its named binding is observed later because the
// release minifier can discard a bare side-effect import.
// ─────────────────────────────────────────────────────────────────
import { bootstrapEnvApplied } from "./bootstrap-env"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import * as Log from "@/util/log"
import { AgentCommand } from "./cli/cmd/agent"
import { UI } from "./cli/ui"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { NamedError } from "@/util/error"
import { FormatError } from "./cli/error"
import { Filesystem } from "@/util/filesystem"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { EOL } from "os"
import { SessionCommand } from "./cli/cmd/session"
import { ApprovalCommand } from "./cli/cmd/approval"
import { bootstrapConfigReady } from "./bootstrap-config"
import { bootstrapBrowserReady } from "./bootstrap-browser"
import { GATEWAY_ARGV } from "./subsystem/gateway/config"
import { JsonMigration } from "@/storage/json-migration"
import { Database } from "@/storage/db"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureProcessMetadata } from "@/util/cyberful-process"
import { isRecord } from "@/util/record"
import { AppRuntime } from "@/effect/app-runtime"
import { DependencyStartup } from "@/dependency/startup"
import { Effect, Schema } from "effect"
import { Truncate } from "@/tool/truncate"
import { emptyTruncationDirSync } from "@/tool/truncation-dir"
import { SubsystemCli } from "@/subsystem/cli"
import { SubsystemContainer } from "@/subsystem/container"
import { SubsystemZapRuntime } from "@/subsystem/zap/runtime"

const processMetadata = ensureProcessMetadata("main")

// ── Installed Assets Are Retained By Observable Bindings ─────────
// Source runs select checked-in built-ins, while release binaries materialize their
// embedded configuration and browser driver before command handling. The minifier
// can drop bare side-effect imports, so named bootstrap results remain observable
// through this opt-in diagnostic. Removing the reads can silently omit release-only
// initialization even when local source execution still works.
// ─────────────────────────────────────────────────────────────────
if (process.env.CYBERFUL_DEBUG_BOOTSTRAP)
  console.error(
    `[bootstrap] env-applied=${bootstrapEnvApplied} embedded-config=${bootstrapConfigReady} embedded-browser=${bootstrapBrowserReady}`,
  )

process.once("exit", emptyTruncationDirSync)

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

// ── Gateway Re-entry Never Falls Through To The CLI ──────────────
// A release binary provides one stable entrypoint; secondary chunks have hashed paths
// that Codex cannot address independently. Phase processes therefore re-enter this
// executable with GATEWAY_ARGV after bootstrap has completed. Dispatch happens before
// yargs construction so stdout remains an MCP-only channel, and the never-resolving
// wait leaves process ownership with the gateway until Codex closes its pipe.
// ─────────────────────────────────────────────────────────────────
if (process.argv.includes(GATEWAY_ARGV)) {
  const { runGatewayMain } = await import("./subsystem/gateway/server")
  await runGatewayMain()
  await new Promise<never>(() => {})
}

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("cyberful ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

function cleanupToolOutputDirectory() {
  return Effect.runPromise(
    Truncate.Service.use((truncate) => truncate.cleanup()).pipe(Effect.provide(Truncate.defaultLayer)),
  )
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("cyberful")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.CYBERFUL_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: InstallationLocal,
      level: (() => {
        if (opts.logLevel) return Schema.decodeUnknownSync(Log.Level)(opts.logLevel)
        if (InstallationLocal) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.CYBERFUL = "1"
    process.env.CYBERFUL_PID = String(process.pid)

    Log.Default.info("cyberful", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      build_id: processMetadata.buildID,
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
      pid: processMetadata.pid,
      started_at: processMetadata.startedAt,
    })

    await cleanupToolOutputDirectory().catch((error) => {
      Log.Default.warn("tool output cleanup failed", { error: errorMessage(error) })
    })

    const databasePath = Database.getPath()
    if (databasePath !== ":memory:" && !(await Filesystem.exists(databasePath))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(AgentCommand)
  .command(SessionCommand)
  .command(ApprovalCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const data: Record<string, unknown> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  await cleanupToolOutputDirectory().catch((error) => {
    Log.Default.warn("tool output cleanup failed", { error: errorMessage(error) })
  })
  await SubsystemCli.killAll().catch((error) => {
    Log.Default.warn("subsystem shutdown failed", { error: errorMessage(error) })
  })
  await AppRuntime.dispose().catch((error) => {
    Log.Default.warn("app runtime shutdown failed", { error: errorMessage(error) })
  })
  await SubsystemCli.killAll().catch((error) => {
    Log.Default.warn("late subsystem shutdown failed", { error: errorMessage(error) })
  })
  await Promise.all([
    SubsystemZapRuntime.removeAll().catch((error) => {
      Log.Default.warn("ZAP container shutdown failed", { error: errorMessage(error) })
    }),
    SubsystemContainer.removeAll().catch((error) => {
      Log.Default.warn("expert container shutdown failed", { error: errorMessage(error) })
    }),
    DependencyStartup.stopStarted().catch((error) => {
      Log.Default.warn("dependency shutdown failed", { error: errorMessage(error) })
    }),
  ])
  await Log.dispose()
  // ── Process Exit Is The Final Cleanup Boundary ──────────────────
  // Some subprocesses and container-backed MCP servers do not terminate reliably
  // when the parent merely finishes its event loop. All cooperative owners above get
  // a bounded cleanup opportunity first, including a second late-spawn sweep. The
  // explicit exit then prevents an unowned handle from keeping the CLI alive after
  // user-visible work and required cleanup have completed.
  // ─────────────────────────────────────────────────────────────────
  process.exit()
}
