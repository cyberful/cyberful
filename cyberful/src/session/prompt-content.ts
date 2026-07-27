// ── Prompt Content Projection ────────────────────────────────────
// Converts journal attachments and message parts into bounded, human-readable
//   bounded AgentRun objective text.
// ─────────────────────────────────────────────────────────────────

import { MessageV2 } from "./message-v2"

export const ATTACHMENT_TEXT_LIMIT = 256_000

export function textMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    /^(application\/(json|xml|yaml|toml|javascript|x-javascript|graphql|sql|x-httpd-php))$/.test(mime)
  )
}

export function attachmentText(name: string | undefined, text: string) {
  const clipped = text.length > ATTACHMENT_TEXT_LIMIT
  const body = clipped ? text.slice(0, ATTACHMENT_TEXT_LIMIT) : text
  return [`Attached text file ${name ?? "file"}:`, body, clipped ? "[Attachment truncated by the journal limit.]" : ""]
    .filter(Boolean)
    .join("\n")
}

export function objectiveFromMessage(message: MessageV2.WithParts) {
  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text" && !part.ignored && part.text.trim()) return [part.text.trim()]
      if (part.type === "file") {
        const location = part.url.startsWith("data:") ? "embedded in the journal text above" : part.url
        return [`Attachment: ${part.filename ?? "file"} (${part.mime}); ${location}`]
      }
      return []
    })
    .join("\n\n")
    .trim()
  const system = message.info.role === "user" ? message.info.system?.trim() : undefined
  return [
    system ? `Additional session constraints:\n${system}` : undefined,
    text || "Complete the requested engagement.",
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n\n")
}
