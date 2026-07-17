// ── Serialized Prompt Queue ──────────────────────────────────────
// Drains submitted prompts one turn at a time, owns the active AbortController,
//   handles local exit or new-session commands, and resolves only after footer
//   closure and in-flight work have completed.
// ─────────────────────────────────────────────────────────────────

import * as Locale from "@/util/locale"
import { isExitCommand, isNewCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, RunPrompt } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  onSend?: (prompt: RunPrompt) => void
  onNewSession?: () => void | Promise<void>
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

type State = {
  queue: RunPrompt[]
  ctrl?: AbortController
  closed: boolean
}

// ── Only One Prompt Turn May Own The Transport ───────────────────
// Footer submissions can arrive while a turn is still running, but the session
// transport accepts one active turn. The queue records all accepted prompts and
// drains them in submission order through `input.run`. Its visible depth keeps
// delayed work explicit, and footer closure aborts the owner before resolving.
// ─────────────────────────────────────────────────────────────────
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const stop = Promise.withResolvers<{ type: "closed" }>()
  const done = Promise.withResolvers<void>()
  const closureReason = new Error("prompt queue closed")
  const state: State = {
    queue: [],
    closed: input.footer.isClosed,
  }
  let draining: Promise<void> | undefined

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const finish = () => {
    if (!state.closed || draining) {
      return
    }

    done.resolve()
  }

  const close = () => {
    if (state.closed) {
      return
    }

    state.closed = true
    state.queue.length = 0
    state.ctrl?.abort(closureReason)
    stop.resolve({ type: "closed" })
    finish()
  }

  const drain = () => {
    if (draining || state.closed || state.queue.length === 0) {
      return
    }

    draining = (async () => {
      try {
        while (!state.closed && state.queue.length > 0) {
          const prompt = state.queue.shift()
          if (!prompt) {
            continue
          }

          if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
            emit(
              {
                type: "queue",
                queue: state.queue.length,
              },
              {
                queue: state.queue.length,
              },
            )
            if (!input.onNewSession) {
              emit(
                {
                  type: "stream.patch",
                  patch: {
                    status: "new sessions unavailable",
                  },
                },
                {
                  status: "new sessions unavailable",
                },
              )
              continue
            }

            emit(
              {
                type: "stream.patch",
                patch: {
                  phase: "running",
                  status: "starting new session",
                  queue: state.queue.length,
                },
              },
              {
                phase: "running",
                status: "starting new session",
                queue: state.queue.length,
              },
            )
            await input.onNewSession()
            continue
          }

          const start = Date.now()
          emit(
            {
              type: "turn.send",
              queue: state.queue.length,
              startedAt: start,
            },
            {
              phase: "running",
              status: "sending prompt",
              queue: state.queue.length,
              startedAt: start,
            },
          )
          const ctrl = new AbortController()
          state.ctrl = ctrl

          try {
            await input.footer.idle()
            if (state.closed) {
              break
            }

            if (prompt.mode !== "shell") {
              const commit = { kind: "user", text: prompt.text, phase: "start", source: "system" } as const
              input.trace?.write("ui.commit", commit)
              input.footer.append(commit)
            }
            input.onSend?.(prompt)

            if (state.closed) {
              break
            }

            const task = input.run(prompt, ctrl.signal).then(
              () => ({ type: "done" as const }),
              (error) => ({ type: "error" as const, error }),
            )

            const next = await Promise.race([task, stop.promise])
            if (next.type === "closed") {
              ctrl.abort(closureReason)
              const stopped = await task
              if (stopped.type === "error" && stopped.error !== ctrl.signal.reason) throw stopped.error
              break
            }

            if (next.type === "error") {
              throw next.error
            }
          } finally {
            if (state.ctrl === ctrl) {
              state.ctrl = undefined
            }

            const duration = Locale.clockDuration(Math.max(0, Date.now() - start))
            emit(
              {
                type: "turn.duration",
                duration,
              },
              {
                duration,
              },
            )
          }
        }
      } catch (error) {
        done.reject(error)
        return
      } finally {
        draining = undefined
        emit(
          {
            type: "turn.idle",
            queue: state.queue.length,
          },
          {
            phase: "idle",
            status: "",
            queue: state.queue.length,
          },
        )
      }

      finish()
    })()
  }

  const submit = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    state.queue.push(prompt)
    emit(
      {
        type: "queue",
        queue: state.queue.length,
      },
      {
        queue: state.queue.length,
      },
    )
    if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
      drain()
      return
    }

    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    drain()
  }

  const offPrompt = input.footer.onPrompt((prompt) => {
    submit(prompt)
  })
  const offClose = input.footer.onClose(() => {
    close()
  })

  try {
    if (state.closed) {
      return
    }

    submit({
      text: input.initialInput ?? "",
      parts: [],
    })
    finish()
    await done.promise
  } finally {
    offPrompt()
    offClose()
    close()
    if (draining) await Promise.allSettled([draining])
  }
}
