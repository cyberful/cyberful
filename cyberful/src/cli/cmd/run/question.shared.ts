// ── Question State Transitions ───────────────────────────────────
// Provides pure transitions for option selection, custom text, tab navigation,
//   and final answers; single questions submit immediately while multi-question
//   requests require the explicit confirmation tab.
// ─────────────────────────────────────────────────────────────────

import type { QuestionInfo, QuestionRequest } from "@/server/client"
import type { QuestionReject, QuestionReply } from "./types"
import { advanceRejectionConfirmation, questionInteractionReady } from "@/question/interaction"

export type QuestionBodyState = {
  requestID: string
  tab: number
  answers: string[][]
  custom: string[]
  selected: number
  editing: boolean
  submitting: boolean
  presentedAt: number
  declineArmedAt?: number
}

export type QuestionStep = {
  state: QuestionBodyState
  reply?: QuestionReply
}

export function questionExitKey(event: {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}): boolean {
  return event.name === "c" && event.ctrl === true && !event.meta && !event.shift && !event.super
}

export function createQuestionBodyState(requestID: string, presentedAt = performance.now()): QuestionBodyState {
  return {
    requestID,
    tab: 0,
    answers: [],
    custom: [],
    selected: 0,
    editing: false,
    submitting: false,
    presentedAt,
    declineArmedAt: undefined,
  }
}

// ── Dismissal Requires Two Deliberate Key Events ─────────────────
// A question can mount while the terminal is still dispatching input from the
// previous surface. One Escape therefore only arms dismissal; a later Escape
// confirms it after the prompt has had time to render. Very fast repeats and
// expired confirmations remain pending and can never impersonate a human decline.
// ─────────────────────────────────────────────────────────────────
export function questionDecline(
  state: QuestionBodyState,
  now: number,
): { state: QuestionBodyState; confirmed: boolean } {
  const next = advanceRejectionConfirmation(state.declineArmedAt, now)
  if (next.armedAt === state.declineArmedAt) return { state, confirmed: next.confirmed }
  return { state: { ...state, declineArmedAt: next.armedAt }, confirmed: next.confirmed }
}

export function questionReady(state: QuestionBodyState, now: number) {
  return questionInteractionReady(state.presentedAt, now)
}

export function questionSync(state: QuestionBodyState, requestID: string): QuestionBodyState {
  if (state.requestID === requestID) {
    return state
  }

  return createQuestionBodyState(requestID)
}

export function questionSingle(request: QuestionRequest): boolean {
  return request.questions.length === 1 && request.questions[0]?.multiple !== true
}

export function questionTabs(request: QuestionRequest): number {
  return questionSingle(request) ? 1 : request.questions.length + 1
}

export function questionConfirm(request: QuestionRequest, state: QuestionBodyState): boolean {
  return !questionSingle(request) && state.tab === request.questions.length
}

export function questionInfo(request: QuestionRequest, state: QuestionBodyState): QuestionInfo | undefined {
  return request.questions[state.tab]
}

export function questionCustom(request: QuestionRequest, state: QuestionBodyState): boolean {
  return questionInfo(request, state)?.custom !== false
}

export function questionInput(state: QuestionBodyState): string {
  return state.custom[state.tab] ?? ""
}

export function questionPicked(state: QuestionBodyState): boolean {
  const value = questionInput(state)
  if (!value) {
    return false
  }

  return state.answers[state.tab]?.includes(value) ?? false
}

export function questionOther(request: QuestionRequest, state: QuestionBodyState): boolean {
  const info = questionInfo(request, state)
  if (!info || info.custom === false) {
    return false
  }

  return state.selected === info.options.length
}

export function questionTotal(request: QuestionRequest, state: QuestionBodyState): number {
  const info = questionInfo(request, state)
  if (!info) {
    return 0
  }

  return info.options.length + (questionCustom(request, state) ? 1 : 0)
}

export function questionAnswers(state: QuestionBodyState, count: number): string[][] {
  return Array.from({ length: count }, (_, idx) => state.answers[idx] ?? [])
}

export function questionSetTab(state: QuestionBodyState, tab: number): QuestionBodyState {
  return {
    ...state,
    tab,
    selected: 0,
    editing: false,
  }
}

export function questionSetSelected(state: QuestionBodyState, selected: number): QuestionBodyState {
  return {
    ...state,
    selected,
  }
}

export function questionSetEditing(state: QuestionBodyState, editing: boolean): QuestionBodyState {
  return {
    ...state,
    editing,
  }
}

export function questionSetSubmitting(state: QuestionBodyState, submitting: boolean): QuestionBodyState {
  return {
    ...state,
    submitting,
  }
}

function storeAnswers(state: QuestionBodyState, tab: number, list: string[]): QuestionBodyState {
  const answers = [...state.answers]
  answers[tab] = list
  return {
    ...state,
    answers,
  }
}

export function questionStoreCustom(state: QuestionBodyState, tab: number, text: string): QuestionBodyState {
  const custom = [...state.custom]
  custom[tab] = text
  return {
    ...state,
    custom,
  }
}

function questionPick(
  state: QuestionBodyState,
  request: QuestionRequest,
  answer: string,
  custom = false,
): QuestionStep {
  const answers = [...state.answers]
  answers[state.tab] = [answer]
  let next: QuestionBodyState = {
    ...state,
    answers,
    editing: false,
  }

  if (custom) {
    const list = [...state.custom]
    list[state.tab] = answer
    next = {
      ...next,
      custom: list,
    }
  }

  if (questionSingle(request)) {
    return {
      state: next,
      reply: {
        requestID: request.id,
        answers: [[answer]],
      },
    }
  }

  return {
    state: questionSetTab(next, state.tab + 1),
  }
}

function questionToggle(state: QuestionBodyState, answer: string): QuestionBodyState {
  const list = [...(state.answers[state.tab] ?? [])]
  const idx = list.indexOf(answer)
  if (idx === -1) {
    list.push(answer)
  } else {
    list.splice(idx, 1)
  }

  return storeAnswers(state, state.tab, list)
}

export function questionMove(state: QuestionBodyState, request: QuestionRequest, dir: -1 | 1): QuestionBodyState {
  const total = questionTotal(request, state)
  if (total === 0) {
    return state
  }

  return {
    ...state,
    selected: (state.selected + dir + total) % total,
  }
}

export function questionSelect(state: QuestionBodyState, request: QuestionRequest): QuestionStep {
  const info = questionInfo(request, state)
  if (!info) {
    return { state }
  }

  if (questionOther(request, state)) {
    if (!info.multiple) {
      return {
        state: questionSetEditing(state, true),
      }
    }

    const value = questionInput(state)
    if (value && questionPicked(state)) {
      return {
        state: questionToggle(state, value),
      }
    }

    return {
      state: questionSetEditing(state, true),
    }
  }

  const option = info.options[state.selected]
  if (!option) {
    return { state }
  }

  if (info.multiple) {
    return {
      state: questionToggle(state, option.label),
    }
  }

  return questionPick(state, request, option.label)
}

export function questionSave(state: QuestionBodyState, request: QuestionRequest): QuestionStep {
  const info = questionInfo(request, state)
  if (!info) {
    return { state }
  }

  const value = questionInput(state).trim()
  const prev = state.custom[state.tab]
  if (!value) {
    if (!prev) {
      return {
        state: questionSetEditing(state, false),
      }
    }

    const next = questionStoreCustom(state, state.tab, "")
    return {
      state: questionSetEditing(
        storeAnswers(
          next,
          state.tab,
          (state.answers[state.tab] ?? []).filter((item) => item !== prev),
        ),
        false,
      ),
    }
  }

  if (info.multiple) {
    const answers = [...(state.answers[state.tab] ?? [])]
    if (prev) {
      const idx = answers.indexOf(prev)
      if (idx !== -1) {
        answers.splice(idx, 1)
      }
    }

    if (!answers.includes(value)) {
      answers.push(value)
    }

    const next = questionStoreCustom(state, state.tab, value)
    return {
      state: questionSetEditing(storeAnswers(next, state.tab, answers), false),
    }
  }

  return questionPick(state, request, value, true)
}

export function questionSubmit(request: QuestionRequest, state: QuestionBodyState): QuestionReply {
  return {
    requestID: request.id,
    answers: questionAnswers(state, request.questions.length),
  }
}

export function questionReject(request: QuestionRequest): QuestionReject {
  return {
    requestID: request.id,
  }
}
