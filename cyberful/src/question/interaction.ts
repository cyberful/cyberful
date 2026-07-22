// ── Explicit Question Interaction Timing ─────────────────────────
// Prevents input carried from a previous terminal surface from being interpreted
//   as an answer or rejection of a newly mounted blocking question.
// → cyberful/src/question/index.ts — enforces the presentation floor server-side.
// → cyberful/src/cli/cmd/run/question.shared.ts — owns terminal interaction gates.
// ─────────────────────────────────────────────────────────────────

export const QUESTION_INTERACTION_MIN_MS = 250
export const REJECTION_CONFIRMATION_MAX_MS = 5_000

export function questionInteractionReady(presentedAt: number, now: number) {
  return now - presentedAt >= QUESTION_INTERACTION_MIN_MS
}

export function advanceRejectionConfirmation(armedAt: number | undefined, now: number) {
  const elapsed = armedAt === undefined ? undefined : now - armedAt
  if (elapsed !== undefined && elapsed >= QUESTION_INTERACTION_MIN_MS && elapsed <= REJECTION_CONFIRMATION_MAX_MS) {
    return { armedAt: undefined, confirmed: true } as const
  }

  if (elapsed !== undefined && elapsed >= 0 && elapsed < QUESTION_INTERACTION_MIN_MS) {
    return { armedAt, confirmed: false } as const
  }

  return { armedAt: now, confirmed: false } as const
}
