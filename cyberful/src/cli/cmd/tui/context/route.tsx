// ── TUI Route State ──────────────────────────────────────────────
// Models home, session, and feature routes and performs typed transitions while
//   preserving route-specific prompt or feature data.
// ─────────────────────────────────────────────────────────────────

import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { isPromptInfo, type PromptInfo } from "../component/prompt/history"
import { isRecord } from "@/util/record"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type FeatureRoute = {
  type: "feature"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | FeatureRoute

function routePrompt(value: unknown): PromptInfo | undefined {
  if (value === undefined) return undefined
  if (isPromptInfo(value)) return value
  throw new Error("CYBERFUL_ROUTE prompt is invalid")
}

export function decodeRoute(value: string | undefined): Route {
  if (!value) return { type: "home" }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error("CYBERFUL_ROUTE must contain valid JSON", { cause: error })
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new Error("CYBERFUL_ROUTE must contain a route object")
  }
  if (parsed.type === "home") return { type: "home", prompt: routePrompt(parsed.prompt) }
  if (parsed.type === "session" && typeof parsed.sessionID === "string" && parsed.sessionID.length > 0) {
    return { type: "session", sessionID: parsed.sessionID, prompt: routePrompt(parsed.prompt) }
  }
  if (parsed.type === "feature" && typeof parsed.id === "string" && parsed.id.length > 0) {
    if (parsed.data !== undefined && !isRecord(parsed.data)) throw new Error("CYBERFUL_ROUTE feature data is invalid")
    return { type: "feature", id: parsed.id, data: parsed.data }
  }
  throw new Error(`Unsupported CYBERFUL_ROUTE type: ${parsed.type}`)
}

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const [store, setStore] = createStore<Route>(props.initialRoute ?? decodeRoute(process.env["CYBERFUL_ROUTE"]))

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  if (route.data.type !== type) throw new Error(`Expected ${type} route, received ${route.data.type}`)
  // ── The Runtime Discriminant Proves The Generic Route ───────────
  // The caller supplies one member of the closed route discriminant union. The
  // equality check rejects every other member before the value is returned.
  // TypeScript cannot retain that narrowing through a caller-selected generic,
  // so the assertion restores only the `Extract` proven by the preceding guard.
  // ───────────────────────────────────────────────────────────────
  return route.data as Extract<Route, { type: typeof type }>
}
