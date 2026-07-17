// ── PTY Connection Ticket Markers ───────────────────────────────
// Defines the path, query, and header markers that route a PTY WebSocket away
// from Basic Auth and into its single-use ticket validation boundary.
// → cyberful/src/server/routes/instance/httpapi/handlers/pty.ts — validates and consumes tickets.
// ─────────────────────────────────────────────────────────────────

export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-cyberful-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

const PTY_CONNECT_PATH = /^\/pty\/[^/]+\/connect$/

export function isPtyConnectPath(pathname: string) {
  return PTY_CONNECT_PATH.test(pathname)
}

export function hasPtyConnectTicketURL(url: URL) {
  return isPtyConnectPath(url.pathname) && !!url.searchParams.get(PTY_CONNECT_TICKET_QUERY)
}
