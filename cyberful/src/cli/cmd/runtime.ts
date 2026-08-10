// ── Local CyberOS Runtime Operator Command ──────────────────────
// Exposes the content-addressed image state, an explicit foreground rebuild,
//   and narrowly scoped cleanup without contacting a Cyberful registry.
// → cyberful/src/dependency/docker-preflight.ts — owns image lifecycle policy.
// @docs/runtimes/cyberful-os.md
// ─────────────────────────────────────────────────────────────────

import type { Argv, CommandModule } from "yargs"
import { DockerPreflight } from "@/dependency/docker-preflight"

interface Arguments {
  readonly action: "status" | "build" | "prune"
  readonly force: boolean
  readonly format: "text" | "json"
}

function builder(yargs: Argv<object>) {
  return yargs
    .positional("action", {
      describe: "operator action",
      choices: ["status", "build", "prune"] as const,
      demandOption: true,
    })
    .option("force", {
      describe: "rebuild even when the current image passes attestation",
      type: "boolean",
      default: false,
    })
    .option("format", {
      describe: "output format",
      choices: ["text", "json"] as const,
      default: "text" as const,
    })
    .check((args) => {
      if (args.force && args.action !== "build") throw new Error("--force is valid only with runtime build")
      return true
    })
}

function print(value: unknown, format: Arguments["format"]) {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value !== "object" || value === null) {
    process.stdout.write(`${String(value)}\n`)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    process.stdout.write(`${key}: ${Array.isArray(item) ? item.join(", ") || "none" : String(item)}\n`)
  }
}

export const RuntimeCommand = {
  command: "runtime <action>",
  describe: "inspect, build, or prune the local content-addressed CyberOS image",
  builder,
  handler: async (args) => {
    if (args.action === "status") print(await DockerPreflight.runtimeStatus(), args.format)
    else if (args.action === "build") print(await DockerPreflight.buildRuntime(args.force), args.format)
    else print(await DockerPreflight.pruneRuntimeImages(), args.format)
  },
} satisfies CommandModule<object, Arguments>
