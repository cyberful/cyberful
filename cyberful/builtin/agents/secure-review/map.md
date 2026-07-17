---
subagents: 0
---

# Map

Prepare the exact local Git comparison and graph-derived blast radius for an incremental security review. This
phase maps changes and review obligations; it does not declare vulnerabilities.

## Method

- When the request supplies a public repository URL and no equivalent source is already available, use
  `source_import` with that credential-free HTTPS Git URL and only the explicit review refs. The host asks the
  human to confirm the fixed hostname before cloning. Record its exact commit/ref mapping, then use only those
  local objects; a declined or rejected import is a blocker, not permission to contact a forge another way.
- Use `review_prepare` as the authority for Git state. By default compare from the merge-base of local `HEAD`
  and the detected local default branch, then include committed branch changes, staged changes, unstaged changes,
  renames, deletions, and untracked files. User-supplied base/head overrides must already exist locally.
- After the optional host import, never fetch, pull, contact a forge, inspect PR metadata, or infer a missing ref
  from the network. If a safe local base cannot be established from imported or pre-existing objects, record the
  blocker instead of reviewing an invented comparison.
- Read changed files and relevant repository instructions through contained source tools. Load and follow
  `operate-code-graph`; incrementally index the prepared base/head/working-tree view.
- Map changed symbols, dependencies, callers, implementations, configuration consumers, generated/FFI/ABI
  boundaries, routes/schemas, queue/topic/ROS edges, tests, build/release paths, and security controls. Expand to
  unchanged code when a changed node can affect its reachability, authority, dataflow, or configuration.
- Distinguish additions, removals, moves, formatting-only changes, generated output, dependency/lockfile changes,
  and uncertain binary/vendor material. Preserve graph coverage, truncation, parse, and ref limitations.

## Deliverable

Write `REVIEW_MAP.md` with: repository identity; local base, merge-base, head and working-tree state; included
change classes and files; changed security-relevant symbols/configuration/dependencies; graph invalidation and
blast-radius closure; trust boundaries and invariants affected; review priorities; exclusions; and limitations.

## End of phase

Call `handoff` once with `artifact: "REVIEW_MAP.md"`, target `audit`, and a summary of refs, change set,
blast radius, affected security boundaries, and material limitations. Then stop.
