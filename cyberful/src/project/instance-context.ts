// ── Project Instance Context And Containment ──────────────────────────────────
// Carries the active project identity and proves whether paths belong to its roots.
// → cyberful/src/project/instance-store.ts — creates and scopes this context.
// ──────────────────────────────────────────────────────────────────────────

import { LocalContext } from "@/util/local-context"
import { AppFileSystem } from "@/effect/filesystem"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

// ── The Filesystem Root Is Not A Project Boundary ─────────────────────────────
// A project may authorize paths under its working directory or a narrower Git
// worktree. Non-Git projects use `/` as a sentinel rather than as permission
// to reach every absolute path. The sentinel must therefore be rejected before
// checking worktree containment, or a non-Git project would escape its boundary.
// The explicit directory check remains valid for both project kinds.
// ─────────────────────────────────────────────────────────────────────────
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (AppFileSystem.contains(ctx.directory, filepath)) return true
  if (ctx.worktree === "/") return false
  return AppFileSystem.contains(ctx.worktree, filepath)
}
