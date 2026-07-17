// ── Session Attention Feature ────────────────────────────────────
// Converts completed, failed, and blocked session events into bounded terminal
//   attention requests while suppressing duplicate and child notifications.
// ─────────────────────────────────────────────────────────────────

import type { Event } from "@/server/client"
import type { TuiFeature, TuiFeatureApi } from "@/cli/cmd/tui/api-types"
import type { InternalTuiFeature } from "../../feature/internal"
import { observePromise } from "@/util/promise"
import * as Log from "@/util/log"

const id = "internal:notifications"
const log = Log.create({ service: "tui.notifications" })

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

function notify(api: TuiFeatureApi, sessionID: string | undefined, message: string) {
  const session = sessionID ? api.state.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  observePromise(
    api.attention.notify({
      title: session?.title,
      message,
      notification: isSubagent ? false : { when: "blurred" },
    }),
    {
      rejected: (error) => log.debug("attention notification failed", { error, sessionID }),
    },
  )
}

function sessionErrorMessage(error: SessionError) {
  if (error?.name === "MessageAbortedError") return "Session aborted"
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return "Model stopped responding"
  }
  return "Session error"
}

const tui: TuiFeature = async (api) => {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()

  api.event.on("question.asked", (event) => {
    if (questions.has(event.properties.id)) return
    questions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Question needs input")
  })

  api.event.on("question.replied", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("question.rejected", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    if (event.properties.status.type === "busy") {
      active.add(sessionID)
      errored.delete(sessionID)
      return
    }

    if (event.properties.status.type !== "idle") return
    if (!active.has(sessionID)) return
    active.delete(sessionID)

    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      return
    }

    notify(api, sessionID, "Session done")
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID) return
    if (!active.has(sessionID)) return
    errored.add(sessionID)
    notify(api, sessionID, sessionErrorMessage(event.properties.error))
  })
}

const feature: InternalTuiFeature = {
  id,
  tui,
}

export default feature
