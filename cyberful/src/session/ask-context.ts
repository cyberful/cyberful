// ── Ask Session Context ───────────────────────────────────────────────────────
// Builds a bounded transcript of recent user and assistant exchanges for Ask.
// It also carries the latest structured completion so follow-up questions retain outcomes.
// → cyberful/src/session/message-v2.ts — defines the messages and completion parts consumed here.
// ────────────────────────────────────────────────────────────────────────

import type { MessageV2 } from "./message-v2"

export const ASK_HISTORY_EXCHANGES = 8
export const ASK_HISTORY_CHARACTERS = 32_000

function messageText(message: MessageV2.WithParts) {
  if (message.info.role === "user")
    return message.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n\n")
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
}

function completionText(messages: readonly MessageV2.WithParts[]) {
  const completion = messages
    .flatMap((message) => message.parts)
    .findLast((part): part is MessageV2.CompletionPart => part.type === "completion")
  if (!completion) return
  const artifacts = completion.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`).join("\n")
  return [
    "## Previous run outcome",
    `**${completion.title}** (${completion.outcome})`,
    completion.summaryMarkdown,
    artifacts ? `Artifacts:\n${artifacts}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
}

export function buildAskContext(messages: readonly MessageV2.WithParts[], currentUserID: string) {
  const history = messages
    .filter(
      (message) =>
        message.info.id !== currentUserID &&
        message.info.agent === "ask" &&
        (message.info.role === "user" || message.info.time.completed !== undefined),
    )
    .flatMap((message) => {
      const content = messageText(message)
      return content ? [`### ${message.info.role === "user" ? "User" : "Ask"}\n${content}`] : []
    })
    .slice(-(ASK_HISTORY_EXCHANGES * 2))
  const prefixText = completionText(messages)
  const prefix =
    prefixText && prefixText.length > ASK_HISTORY_CHARACTERS
      ? `${prefixText.slice(0, ASK_HISTORY_CHARACTERS - 1)}…`
      : prefixText
  if (prefix?.length === ASK_HISTORY_CHARACTERS) return prefix

  const heading = "## Recent Ask conversation"
  const selected: string[] = []
  let characters = (prefix?.length ?? 0) + (prefix ? 2 : 0) + heading.length + 1
  for (const block of history.toReversed()) {
    const separator = selected.length ? 2 : 0
    const remaining = ASK_HISTORY_CHARACTERS - characters - separator
    if (remaining <= 1) break
    if (block.length > remaining) {
      if (!selected.length) selected.unshift(`${block.slice(0, remaining - 1)}…`)
      break
    }
    selected.unshift(block)
    characters += block.length + separator
  }
  return [prefix, selected.length ? `${heading}\n${selected.join("\n\n")}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
}

export * as SessionAskContext from "./ask-context"
