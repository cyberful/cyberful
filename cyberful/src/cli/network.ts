// ── CLI Network Options ──────────────────────────────────────────
// Registers the shared listener port option and normalizes parsed yargs input
//   into the network configuration consumed by server commands.
// ─────────────────────────────────────────────────────────────────

import type { Argv, InferredOptionTypes } from "yargs"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
export function resolveNetworkOptionsNoConfig(args: NetworkOptions) {
  return { port: args.port }
}
