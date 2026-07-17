// ── Application Process Output Contract ───────────────────────────
// Exercises a real local subprocess and verifies routine command output is
// bounded without losing exit status or leaving the process scope open.
// → cyberful/src/effect/process.ts — collects bounded process results.
// ────────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Service, defaultLayer } from "./process"

test("routine subprocess output is bounded and reports successful completion", async () => {
  const result = await Effect.runPromise(
    Service.use((processService) =>
      processService.run(
        ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("abcdefghijklmnop")'], {
          stdin: "ignore",
        }),
        { maxOutputBytes: 8, maxErrorBytes: 8, timeout: "5 seconds" },
      ),
    ).pipe(Effect.provide(defaultLayer)),
  )

  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString("utf8")).toBe("abcdefgh")
  expect(result.stdoutTruncated).toBe(true)
  expect(result.stderr.toString("utf8")).toBe("")
})
