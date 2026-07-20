// ── External Approval Commands ───────────────────────────────────
// Lists live blocking questions and submits one validated selection so a local
//   or remotely directed coding assistant can resume the owning Cyberful run.
// → cyberful/src/question/mailbox.ts — owns cross-process request decisions.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import type { Argv } from "yargs"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Global } from "@/global"
import { ApprovalMailbox, type PendingRequest, type Question } from "@/question/mailbox"
import { errorMessage } from "@/util/error"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

function selectorAnswer(question: Question, selector: string, position: number): string {
  const numbered = /^#?(\d+)$/.exec(selector.trim())
  if (numbered) {
    const index = Number(numbered[1]) - 1
    const option = question.options[index]
    if (!option) throw new Error(`selector ${position} is outside the available option range`)
    return option.label
  }
  const option = question.options.find((candidate) => candidate.label === selector)
  if (option) return option.label
  if (question.custom === false) throw new Error(`selector ${position} is not an allowed option label`)
  const custom = selector.trim()
  if (!custom) throw new Error(`selector ${position} is empty`)
  return custom
}

export function resolveSelectors(request: PendingRequest, selectors: readonly string[]): string[][] {
  if (selectors.length !== request.questions.length)
    throw new Error(`expected ${request.questions.length} selector(s), received ${selectors.length}`)
  return request.questions.map((question, index) => [selectorAnswer(question, selectors[index] ?? "", index + 1)])
}

function parseAnswers(raw: string): string[][] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error("--answers must be a JSON array of string arrays", { cause: error })
  }
  if (
    !Array.isArray(value) ||
    !value.every((answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"))
  )
    throw new Error("--answers must be a JSON array of string arrays")
  return value.map((answer) => [...answer])
}

function mailboxEffect<T>(operation: () => Promise<T>): Effect.Effect<T, CliError> {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => new Error(errorMessage(error)),
  }).pipe(Effect.catch((error) => fail(error.message)))
}

function formatTable(requests: readonly PendingRequest[]): string {
  const lines: string[] = []
  for (const request of requests) {
    lines.push(`${request.id}  session=${request.sessionID}  ${request.active ? "WAITING" : "ORPHANED"}`)
    request.questions.forEach((question, questionIndex) => {
      lines.push(`  ${questionIndex + 1}. [${question.header}] ${question.question}`)
      question.options.forEach((option, optionIndex) => {
        lines.push(`     #${optionIndex + 1} ${option.label} — ${option.description}`)
      })
      if (question.custom !== false) lines.push("     custom answer allowed")
    })
  }
  return lines.join(EOL)
}

export const ApprovalCommand = cmd({
  command: "approval",
  describe: "inspect and resolve a blocking Cyberful approval",
  builder: (yargs: Argv) =>
    yargs.command(ApprovalListCommand).command(ApprovalReplyCommand).command(ApprovalRejectCommand).demandCommand(),
  async handler() {},
})

export const ApprovalListCommand = effectCmd({
  command: "list",
  describe: "list pending approval requests",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("session", {
        describe: "show only one Cyberful session ID",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.approval.list")(function* (args) {
    const mailbox = ApprovalMailbox.make(Global.Path.state)
    const requests = (yield* mailboxEffect(() => mailbox.list()))
      .filter((request) => !args.session || request.sessionID === args.session)
      .toSorted((left, right) => left.createdAt - right.createdAt)
    if (requests.length === 0) return
    process.stdout.write((args.format === "json" ? JSON.stringify(requests, null, 2) : formatTable(requests)) + EOL)
  }),
})

export const ApprovalReplyCommand = effectCmd({
  command: "reply <requestID>",
  describe: "answer a pending approval by option number, exact label, or JSON",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("requestID", {
        describe: "pending request ID from approval list",
        type: "string",
        demandOption: true,
      })
      .option("select", {
        describe: "one selector per question; use #1, #2, an exact label, or allowed custom text",
        type: "string",
        array: true,
      })
      .option("answers", {
        describe: "complete JSON string matrix for multi-select answers",
        type: "string",
      })
      .check((args) => {
        if (args.select?.length && args.answers) throw new Error("use either --select or --answers, not both")
        if (!args.select?.length && !args.answers) throw new Error("provide --select or --answers")
        return true
      }),
  handler: Effect.fn("Cli.approval.reply")(function* (args) {
    const mailbox = ApprovalMailbox.make(Global.Path.state)
    const request = yield* mailboxEffect(() => mailbox.read(args.requestID))
    const answers = args.answers ? parseAnswers(args.answers) : resolveSelectors(request, args.select ?? [])
    yield* mailboxEffect(() => mailbox.answer(args.requestID, answers))
    process.stdout.write(`Approval ${args.requestID} answered.${EOL}`)
  }),
})

export const ApprovalRejectCommand = effectCmd({
  command: "reject <requestID>",
  describe: "reject a pending approval",
  instance: false,
  builder: (yargs) =>
    yargs.positional("requestID", {
      describe: "pending request ID from approval list",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.approval.reject")(function* (args) {
    const mailbox = ApprovalMailbox.make(Global.Path.state)
    yield* mailboxEffect(() => mailbox.reject(args.requestID))
    process.stdout.write(`Approval ${args.requestID} rejected.${EOL}`)
  }),
})
