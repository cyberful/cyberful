// ── Native MCP Human Question Contract ──────────────────────────
// Defines the bounded, versioned Cyberful approval envelope carried by a
// standard MCP form elicitation and translates its primitive form content.
// → cyberful/src/subsystem/gateway/server.ts — creates native elicitations.
// → cyberful/src/subsystem/cli.ts — validates and routes them to the mailbox/TUI.
// ─────────────────────────────────────────────────────────────────

import { isRecord } from "@/util/record"

const MAX_QUESTIONS = 3
const MAX_OPTIONS = 20
const MAX_ANSWER_VALUES = 20
const MAX_QUESTION_LENGTH = 8_000
const MAX_HEADER_LENGTH = 30
const MAX_LABEL_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_ANSWER_LENGTH = 8_000

export const APPROVAL_ELICITATION_META_KEY = "cyberful.dev/approval"
export const HUMAN_DECISION_META_KEY = "cyberful.dev/human-decision"

export interface HumanQuestion {
  question: string
  header: string
  options: ReadonlyArray<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

export type HumanAnswers = ReadonlyArray<ReadonlyArray<string>>
export type AskHuman = (questions: ReadonlyArray<HumanQuestion>, signal: AbortSignal) => Promise<HumanAnswers>

interface ApprovalElicitationEnvelope {
  version: 1
  kind: "approval"
  questions: ReadonlyArray<HumanQuestion>
}

interface HumanDecisionEnvelope {
  version: 1
  source: "human"
}

export interface ApprovalElicitationSchema {
  type: "object"
  properties: Record<
    string,
    {
      type: "string"
      title: string
      description: string
      minLength: number
      maxLength: number
    }
  >
  required: string[]
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
}

function parseQuestion(input: unknown): HumanQuestion | undefined {
  if (!isRecord(input)) return
  if (
    !boundedString(input.question, MAX_QUESTION_LENGTH) ||
    !boundedString(input.header, MAX_HEADER_LENGTH) ||
    !Array.isArray(input.options) ||
    input.options.length > MAX_OPTIONS
  )
    return
  if (input.multiple !== undefined && typeof input.multiple !== "boolean") return
  if (input.custom !== undefined && typeof input.custom !== "boolean") return
  const options = input.options.flatMap((option) =>
    isRecord(option) &&
    boundedString(option.label, MAX_LABEL_LENGTH) &&
    boundedString(option.description, MAX_DESCRIPTION_LENGTH)
      ? [{ label: option.label, description: option.description }]
      : [],
  )
  if (options.length !== input.options.length) return
  return {
    question: input.question,
    header: input.header,
    options,
    ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
    ...(input.custom === undefined ? {} : { custom: input.custom }),
  }
}

export function parseHumanQuestions(value: unknown): HumanQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) return
  const questions = value.flatMap((question) => {
    const parsed = parseQuestion(question)
    return parsed ? [parsed] : []
  })
  return questions.length === value.length ? questions : undefined
}

export function approvalElicitationMetadata(questions: ReadonlyArray<HumanQuestion>): Record<string, unknown> {
  return {
    [APPROVAL_ELICITATION_META_KEY]: {
      version: 1,
      kind: "approval",
      questions,
    } satisfies ApprovalElicitationEnvelope,
  }
}

export function parseApprovalElicitationMetadata(value: unknown): HumanQuestion[] | undefined {
  if (!isRecord(value)) return
  const envelope = value[APPROVAL_ELICITATION_META_KEY]
  if (!isRecord(envelope) || envelope.version !== 1 || envelope.kind !== "approval") return
  if (Object.keys(envelope).some((key) => !["version", "kind", "questions"].includes(key))) return
  return parseHumanQuestions(envelope.questions)
}

// ── A Decline Is Human Only With End-To-End Attestation ──────────
// MCP transports may collapse client routing errors or unavailable selectors
// into the same `decline` action used for an operator rejection. Cyberful adds
// this metadata only after its selector returns or throws the typed rejection,
// and the gateway requires it before attributing the decision to the human.
// Missing or malformed metadata therefore remains non-authorizing without
// inventing an operator action that never occurred.
// ─────────────────────────────────────────────────────────────────
export function humanDecisionMetadata(): Record<string, unknown> {
  return {
    [HUMAN_DECISION_META_KEY]: {
      version: 1,
      source: "human",
    } satisfies HumanDecisionEnvelope,
  }
}

export function hasHumanDecisionMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false
  const envelope = value[HUMAN_DECISION_META_KEY]
  return (
    isRecord(envelope) &&
    envelope.version === 1 &&
    envelope.source === "human" &&
    Object.keys(envelope).every((key) => ["version", "source"].includes(key))
  )
}

// ── Primitive Form Content Preserves Rich Cyberful Answers ──────
// MCP form elicitation intentionally permits only primitive top-level fields,
// and transports may normalize optional JSON Schema annotations like `$schema`.
// Cyberful emits only the functional form shape and compares it exactly with
// the versioned metadata before routing the question. Each answer set remains a
// JSON-encoded string array validated at both ends before it can authorize work.
// ─────────────────────────────────────────────────────────────────
export function approvalElicitationSchema(questions: ReadonlyArray<HumanQuestion>): ApprovalElicitationSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      questions.map((question, index) => [
        `q${index}`,
        {
          type: "string" as const,
          title: question.header,
          description: `${question.question} Return a JSON array of selected labels or allowed custom values.`,
          minLength: 2,
          maxLength: MAX_ANSWER_LENGTH * MAX_ANSWER_VALUES + 1_024,
        },
      ]),
    ),
    required: questions.map((_, index) => `q${index}`),
  }
}

export function validateHumanAnswers(
  questions: ReadonlyArray<HumanQuestion>,
  answers: HumanAnswers,
): string[][] | undefined {
  if (answers.length !== questions.length) return
  const validated: string[][] = []
  for (const [index, answer] of answers.entries()) {
    const question = questions[index]
    if (!question || answer.length < 1 || answer.length > MAX_ANSWER_VALUES) return
    if (question.multiple !== true && answer.length !== 1) return
    const values: string[] = []
    for (const value of answer) {
      if (!boundedString(value, MAX_ANSWER_LENGTH)) return
      if (question.custom === false && !question.options.some((option) => option.label === value)) return
      values.push(value)
    }
    validated.push(values)
  }
  return validated
}

export function approvalElicitationContent(
  questions: ReadonlyArray<HumanQuestion>,
  answers: HumanAnswers,
): Record<string, string> | undefined {
  const validated = validateHumanAnswers(questions, answers)
  if (!validated) return
  return Object.fromEntries(validated.map((answer, index) => [`q${index}`, JSON.stringify(answer)]))
}

export function parseApprovalElicitationContent(
  questions: ReadonlyArray<HumanQuestion>,
  value: unknown,
): string[][] | undefined {
  if (!isRecord(value)) return
  const expectedKeys = questions.map((_, index) => `q${index}`)
  const keys = Object.keys(value)
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) return
  const answers: string[][] = []
  for (const key of expectedKeys) {
    const encoded = value[key]
    if (typeof encoded !== "string") return
    let decoded: unknown
    try {
      decoded = JSON.parse(encoded)
    } catch {
      return
    }
    if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === "string")) return
    answers.push(decoded)
  }
  return validateHumanAnswers(questions, answers)
}

export function isQuestionRejected(error: unknown): boolean {
  return isRecord(error) && error._tag === "QuestionRejectedError"
}
