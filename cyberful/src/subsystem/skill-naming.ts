// ── First-Party Skill Intent Vocabulary ─────────────────────────
// Keeps discovery names operationally meaningful while preserving the
// authorization and tool boundaries owned by the immutable system contract.
// → cyberful/src/subsystem/pi-skills.ts — validates first-party packages.
// → cyberful/src/subsystem/prompt-compiler.ts — explains prefixes to the model.
// ─────────────────────────────────────────────────────────────────

export const FIRST_PARTY_SKILL_INTENTS = [
  { prefix: "test-", explanation: "prove vulnerabilities/broken invariants" },
  { prefix: "audit-", explanation: "inspect source/configuration/architecture" },
  { prefix: "trace-", explanation: "reconstruct causes/dataflows" },
  { prefix: "analyze-", explanation: "turn artifacts into offline evidence" },
  { prefix: "operate-", explanation: "use tools/toolchains" },
  { prefix: "assess-", explanation: "combine analysis modes" },
  { prefix: "plan-", explanation: "prepare scope/strategy/coverage" },
] as const

const FIRST_PARTY_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)+$/

export function assertFirstPartySkillName(name: string, location: string): void {
  const hasKnownIntent = FIRST_PARTY_SKILL_INTENTS.some(({ prefix }) => name.startsWith(prefix))
  if (name.length <= 63 && FIRST_PARTY_SKILL_NAME.test(name) && hasKnownIntent) return

  const prefixes = FIRST_PARTY_SKILL_INTENTS.map(({ prefix }) => prefix).join(", ")
  throw new Error(
    `first-party skill '${name}' at '${location}' must be lowercase kebab-case, shorter than 64 characters, and begin with one of: ${prefixes}`,
  )
}

export function skillIntentInstructions(): string {
  return [
    "Skill intents by prefix:",
    ...FIRST_PARTY_SKILL_INTENTS.map(({ prefix, explanation }) => `- ${prefix}* — ${explanation}.`),
    "Prefixes never grant authorization/tools/execution; use descriptions/triggers for relevance.",
  ].join("\n")
}
