// ── Validated Artifact Opener ────────────────────────────────────
// Proves a completion artifact remains inside its workarea, resolves its real
//   path, and tries shell-free platform openers until one succeeds.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { realpath } from "node:fs/promises"
import { SessionCompletion } from "@/session/completion"
import { Process } from "@/util/process"

export function openerCommands(platform: NodeJS.Platform, target: string): string[][] {
  if (platform === "darwin") return [["open", target]]
  if (platform === "win32") return [["explorer.exe", target]]
  return [
    ["xdg-open", target],
    ["gio", "open", target],
  ]
}

export async function openArtifact(root: string, relativePath: string) {
  const valid = await SessionCompletion.validateArtifacts(root, [
    { label: path.basename(relativePath), path: relativePath },
  ])
  if (!valid[0]) throw new Error("The artifact is missing or is outside the workarea.")
  const target = await realpath(path.resolve(root, valid[0].path))
  let failure = "No system opener is available."
  for (const command of openerCommands(process.platform, target)) {
    const attempt = await Process.run(command, { nothrow: true }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    if ("error" in attempt) {
      failure = attempt.error instanceof Error ? attempt.error.message : failure
      continue
    }
    const result = attempt.result
    if (result.code === 0) return
    failure = result.stderr.toString().trim() || failure
  }
  throw new Error(failure)
}

export * as OpenArtifact from "./open-artifact"
