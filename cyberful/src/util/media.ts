// ── Attachment Media Classification ─────────────────────────────
// Classifies image and PDF MIME types before attachments enter versioned
// session messages and downstream model-input paths.
// → cyberful/src/session/message-v2.ts — exposes the shared classification.
// ─────────────────────────────────────────────────────────────────

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}
