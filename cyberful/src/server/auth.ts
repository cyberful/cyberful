// ── Loopback Server Authentication ──────────────────────────────
// Reads the optional Basic Auth configuration and produces or validates the
// credentials used by local control-plane clients and HTTP middleware.
// → cyberful/src/server/routes/instance/httpapi/middleware/authorization.ts — enforces this policy.
// ─────────────────────────────────────────────────────────────────

export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@cyberful/ServerAuthConfig", {
  password: EffectConfig.string("CYBERFUL_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("CYBERFUL_SERVER_USERNAME").pipe(EffectConfig.withDefault("cyberful")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.CYBERFUL_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.CYBERFUL_SERVER_USERNAME ?? "cyberful"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
