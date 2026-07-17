#!/usr/bin/env bun
// ── Source Checkout Build Identity ──────────────────────────────────
// Derives a stable identity from HEAD plus tracked and untracked TUI changes so
// source launches invalidate runtime caches only when their executable UI changes.
// → cyberful/src/index.ts — consumes this identity during source-mode startup.
// ────────────────────────────────────────────────────────────────────

import path from "node:path"

const text = new TextDecoder()

function git(root: string, args: string[]) {
  try {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 30_000,
      maxBuffer: 8_388_608,
    })
    return result.exitCode === 0 ? text.decode(result.stdout) : undefined
  } catch {
    return
  }
}

// ── Source Identity Degrades Without Blocking Startup ─────────────────
// A source launch may run outside Git, during an incomplete checkout, or without a
// usable Git executable. Identity is only a cache invalidation aid, so those failures
// deliberately select one explicit unbundled value instead of blocking the product.
// In a healthy checkout, HEAD and tracked changes are hashed with every unignored
// TUI path and its streamed bytes, covering staged and untracked executable content.
// ────────────────────────────────────────────────────────────────
export async function sourceBuildID(root: string) {
  const repository = git(root, ["rev-parse", "--show-toplevel"])?.trim()
  if (!repository) return "source-unbundled"
  const head = git(repository, ["rev-parse", "HEAD"])?.trim()
  const diff = git(repository, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", "tui"])
  const untracked = git(repository, ["ls-files", "--others", "--exclude-standard", "-z", "--", "tui"])
  if (!head || diff === undefined || untracked === undefined) return "source-unbundled"

  const hash = new Bun.CryptoHasher("sha256").update(head).update("\0").update(diff)
  for (const file of untracked.split("\0").filter(Boolean).sort()) {
    hash.update("\0").update(file).update("\0")
    try {
      const reader = Bun.file(path.join(repository, file)).stream().getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          hash.update(chunk.value)
        }
      } finally {
        reader.releaseLock()
      }
    } catch {
      hash.update("<unreadable>")
    }
  }
  return `source-${head.slice(0, 12)}-${hash.digest("hex").slice(0, 16)}`
}

if (import.meta.main) console.log(await sourceBuildID(process.cwd()))
