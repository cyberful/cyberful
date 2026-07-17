#!/usr/bin/env bun
// ── Repository Release Planning ─────────────────────────────────────
// Classifies distributable commits, computes the required semantic version
// bump, and emits resumable CI state without consulting a mutable registry.
// → .github/workflows/release.yml — executes the serialized release decision.
// @docs/development/release.md
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import semver from "semver"

export type ReleaseBump = "major" | "minor" | "patch"

export type ReleaseCommit = {
  subject: string
  body: string
  files: string[]
}

export type ReleasePlan = {
  release: boolean
  version?: string
  bump?: ReleaseBump
  previousTag?: string
  head: string
  relevantCommits: number
  resume: boolean
}

const BUMP_WEIGHT = { patch: 1, minor: 2, major: 3 } as const
const CONVENTIONAL_TITLE = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^)]+\))?!?: .+/

function versionFromTag(tag: string) {
  const version = tag.startsWith("v") ? tag.slice(1) : ""
  if (!semver.valid(version)) throw new Error(`Invalid release tag: ${tag}`)
  return version
}

function isRequestedBump(value: string): value is ReleaseBump | "auto" {
  return value === "auto" || value === "patch" || value === "minor" || value === "major"
}

function environmentBoolean(name: string) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return false
  const value = raw.trim().toLowerCase()
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  throw new Error(`${name} must be one of: true, 1, false, 0`)
}

export function isConventionalTitle(title: string) {
  return CONVENTIONAL_TITLE.test(title.trim())
}

export function isReleaseFile(file: string) {
  const normalized = file.replaceAll("\\", "/")
  if (/\.(integration\.)?test\.[cm]?[jt]sx?$/.test(normalized)) return false
  if (/(^|\/)tests?(\/|$)/.test(normalized)) return false
  if (/(^|\/)README\.md$/.test(normalized)) return false
  if (/^cyberful\/(src|builtin|bin|migration|script)\//.test(normalized)) return true
  if (normalized === "cyberful/package.json") return true
  if (/^mcps\/(browser|cyberful-os|zap)\//.test(normalized)) return true
  return [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "mcps/package.json",
    "scripts/release.ts",
  ].includes(normalized)
}

export function planRelease(input: {
  head: string
  previousTag?: string
  commits: ReleaseCommit[]
  requestedBump?: ReleaseBump | "auto"
  forceWithoutChanges?: boolean
  reason?: string
}) {
  if (input.previousTag) versionFromTag(input.previousTag)
  const commits = input.commits.filter((commit) => commit.files.some(isReleaseFile))
  const automaticBump = commits.reduce<ReleaseBump | undefined>((current, commit) => {
    const next =
      /^[a-z]+(?:\([^)]+\))?!:/.test(commit.subject) || /^BREAKING(?: |-)?CHANGE:/m.test(commit.body)
        ? "major"
        : /^feat(?:\([^)]+\))?!?:/.test(commit.subject)
          ? "minor"
          : "patch"
    if (!current || BUMP_WEIGHT[next] > BUMP_WEIGHT[current]) return next
    return current
  }, undefined)

  if (!automaticBump && !input.forceWithoutChanges) {
    return {
      release: false,
      head: input.head,
      relevantCommits: 0,
      resume: false,
      ...(input.previousTag ? { previousTag: input.previousTag } : {}),
    } satisfies ReleasePlan
  }

  if (!automaticBump && !input.reason?.trim()) {
    throw new Error("A reason is required when forcing a release without distributable changes")
  }

  const requestedBump = input.requestedBump === "auto" || !input.requestedBump ? undefined : input.requestedBump
  if (automaticBump && requestedBump && BUMP_WEIGHT[requestedBump] < BUMP_WEIGHT[automaticBump]) {
    throw new Error(`The requested ${requestedBump} bump cannot lower the automatic ${automaticBump} bump`)
  }

  const bump = requestedBump ?? automaticBump ?? "patch"
  const previousVersion = input.previousTag?.slice(1)
  const version = previousVersion ? semver.inc(previousVersion, bump) : "0.1.0"
  if (!version) throw new Error(`Cannot apply a ${bump} bump to ${previousVersion}`)

  return {
    release: true,
    version,
    bump,
    head: input.head,
    relevantCommits: commits.length,
    resume: false,
    ...(input.previousTag ? { previousTag: input.previousTag } : {}),
  } satisfies ReleasePlan
}

export function resumeRelease(input: { tag: string; head: string; previousTag?: string; relevantCommits: number }) {
  const version = versionFromTag(input.tag)
  if (input.previousTag) versionFromTag(input.previousTag)
  return {
    release: true,
    version,
    head: input.head,
    relevantCommits: input.relevantCommits,
    resume: true,
    ...(input.previousTag ? { previousTag: input.previousTag } : {}),
  } satisfies ReleasePlan
}

function git(repositoryRoot: string, args: string[]) {
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(["git", ...args], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      maxBuffer: 16_777_216,
    })
  } catch (error) {
    throw new Error("Cannot start git while planning the release", { cause: error })
  }
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim().slice(0, 2_000)
    throw new Error(`git release query exited with status ${result.exitCode}${detail ? `: ${detail}` : ""}`)
  }
  return new TextDecoder().decode(result.stdout).trim()
}

function stableTags(repositoryRoot: string, head: string) {
  return git(repositoryRoot, ["tag", "--merged", head, "--list", "v*", "--sort=-version:refname"])
    .split("\n")
    .filter((tag) => tag && semver.valid(tag.slice(1)))
}

function commitsBetween(repositoryRoot: string, previousTag: string | undefined, head: string) {
  const hashes = git(repositoryRoot, [
    "rev-list",
    "--reverse",
    "--end-of-options",
    previousTag ? `${previousTag}..${head}` : head,
  ])
    .split("\n")
    .filter(Boolean)
  return hashes.map((hash) => ({
    subject: git(repositoryRoot, ["show", "-s", "--format=%s", hash]),
    body: git(repositoryRoot, ["show", "-s", "--format=%b", hash]),
    files: git(repositoryRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", hash])
      .split("\n")
      .filter(Boolean),
  }))
}

export function planRepositoryRelease(input: {
  repositoryRoot: string
  head: string
  resumeTag?: string
  requestedBump?: ReleaseBump | "auto"
  forceWithoutChanges?: boolean
  reason?: string
}) {
  if (input.resumeTag) {
    versionFromTag(input.resumeTag)
    const head = git(input.repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${input.resumeTag}^{commit}`])
    const previousTag = stableTags(input.repositoryRoot, head).find((tag) => tag !== input.resumeTag)
    return resumeRelease({
      tag: input.resumeTag,
      head,
      relevantCommits: commitsBetween(input.repositoryRoot, previousTag, head).filter((commit) =>
        commit.files.some(isReleaseFile),
      ).length,
      ...(previousTag ? { previousTag } : {}),
    })
  }

  const head = git(input.repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${input.head}^{commit}`])
  const previousTag = stableTags(input.repositoryRoot, head)[0]
  return planRelease({
    head,
    commits: commitsBetween(input.repositoryRoot, previousTag, head),
    requestedBump: input.requestedBump,
    forceWithoutChanges: input.forceWithoutChanges,
    reason: input.reason,
    ...(previousTag ? { previousTag } : {}),
  })
}

function argument(name: string) {
  const indexes = Bun.argv.flatMap((value, index) => (value === name ? [index] : []))
  if (indexes.length > 1) throw new Error(`${name} may be passed only once`)
  if (indexes.length === 0) return
  const value = Bun.argv[indexes[0] + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function writeGithubOutput(plan: ReleasePlan) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required with --github-output")
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `release=${plan.release}`,
      `version=${plan.version ?? ""}`,
      `bump=${plan.bump ?? ""}`,
      `previous_tag=${plan.previousTag ?? ""}`,
      `head=${plan.head}`,
      `resume=${plan.resume}`,
      `relevant_commits=${plan.relevantCommits}`,
    ].join("\n") + "\n",
  )
}

if (import.meta.main) {
  if (Bun.argv.includes("--validate-title")) {
    const title = process.env.PR_TITLE?.trim() || ""
    if (!isConventionalTitle(title)) {
      throw new Error(`PR title must follow Conventional Commits: ${title || "<empty>"}`)
    }
    console.log(title)
  } else {
    const requestedBump = argument("--bump") || process.env.RELEASE_BUMP?.trim() || "auto"
    if (!isRequestedBump(requestedBump)) {
      throw new Error(`Invalid bump: ${requestedBump}`)
    }
    const plan = planRepositoryRelease({
      repositoryRoot: process.cwd(),
      head: argument("--head") || process.env.RELEASE_HEAD?.trim() || "HEAD",
      resumeTag: argument("--resume-tag") || process.env.RELEASE_RESUME_TAG?.trim() || undefined,
      requestedBump,
      forceWithoutChanges: environmentBoolean("RELEASE_FORCE"),
      reason: process.env.RELEASE_REASON,
    })
    if (Bun.argv.includes("--github-output")) writeGithubOutput(plan)
    console.log(JSON.stringify(plan, null, 2))
  }
}
