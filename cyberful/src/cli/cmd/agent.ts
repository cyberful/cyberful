// ── Agent Listing Command ────────────────────────────────────────
// Lists repository-owned phase personas in stable name order without invoking
//   or modifying their runtime policy.
// ─────────────────────────────────────────────────────────────────

import { Agent } from "@/agent/agent"
import { effectCmd } from "../effect-cmd"
import { EOL } from "node:os"
import { Effect } from "effect"

export const AgentCommand = effectCmd({
  command: "agent list",
  describe: "list available phase agents",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const agents = yield* Agent.Service.use((service) => service.list())
    for (const agent of agents.toSorted((left, right) => left.name.localeCompare(right.name))) {
      process.stdout.write(`${agent.name} (${agent.workflow ?? agent.mode})` + EOL)
    }
  }),
})
