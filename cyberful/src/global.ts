// ── Application Paths And Global Context ─────────────────────────
// Resolves Cyberful's XDG directories, prepares required local storage, and
// exposes the path set through an injectable Effect service.
// → cyberful/src/bootstrap-env.ts — must establish environment values before this module loads.
// → cyberful/src/util/flock.ts — uses the resolved state directory for process locks.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import fs from "node:fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "node:os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"

const app = "cyberful"

function requireBase(name: string, value: string | undefined): string {
  if (value) return value
  throw new Error(`Unable to resolve the ${name} base directory for this platform`)
}

const data = path.join(requireBase("XDG data", xdgData), app)
const cache = path.join(requireBase("XDG cache", xdgCache), app)
const config = path.join(requireBase("XDG config", xdgConfig), app)
const state = path.join(requireBase("XDG state", xdgState), app)
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.CYBERFUL_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

// ── Path Consumers Never Observe A Partial Directory Set ─────────
// Global paths are resolved exactly once after environment bootstrap and before
// services that persist state are created. Required directories are prepared
// concurrently because they are independent, and top-level await prevents any
// importer from proceeding until every creation succeeds. A filesystem failure
// aborts startup instead of allowing later modules to fail against partial state.
// ─────────────────────────────────────────────────────────────────
await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@cyberful/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.CYBERFUL_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
