// ── Engagement Completion Candidate Validation ──────────────────
// Narrows model-provided completion data into bounded display text and safe,
// relative artifact references suitable for terminal workflow presentation.
// → cyberful/src/subsystem/orchestrator.ts — carries validated completion outcomes.
// ─────────────────────────────────────────────────────────────────

import path from "path"
import { isRecord } from "@/util/record"

export interface CandidateArtifact {
  label: string
  path: string
}

export interface Candidate {
  title: string
  summaryMarkdown: string
  artifacts: CandidateArtifact[]
}

export function safeRelativeArtifactPath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/")
  if (!normalized || path.posix.isAbsolute(normalized)) return
  if (normalized.split("/").some((part) => part === ".." || part === "")) return
  return normalized
}

export function parseCandidate(input: unknown): Candidate | undefined {
  if (!isRecord(input)) return
  const title = typeof input.title === "string" ? input.title.trim() : ""
  const summaryMarkdown = typeof input.summaryMarkdown === "string" ? input.summaryMarkdown.trim() : ""
  if (!title || !summaryMarkdown) return
  const artifacts = Array.isArray(input.artifacts)
    ? input.artifacts.flatMap((artifact) => {
        if (!isRecord(artifact)) return []
        const label = typeof artifact.label === "string" ? artifact.label.trim() : ""
        const candidate = typeof artifact.path === "string" ? safeRelativeArtifactPath(artifact.path) : undefined
        return label && candidate ? [{ label, path: candidate }] : []
      })
    : []
  return { title, summaryMarkdown, artifacts: artifacts.slice(0, 5) }
}

export function normalizeTitle(value: string | undefined, fallback: string): string {
  const title = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || fallback
  return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`
}

export function normalizeSummary(value: string | undefined, fallback: string): string {
  const lines = (value ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(0, 5)
  return (lines.length ? lines : fallback.split("\n").slice(0, 5))
    .map((line) => (line.length <= 240 ? line : `${line.slice(0, 239).trimEnd()}…`))
    .join("\n")
}

export * as SubsystemCompletion from "./completion"
