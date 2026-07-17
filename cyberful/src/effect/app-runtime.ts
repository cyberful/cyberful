// ── Application Effect Runtime ─────────────────────────────────────
// Assembles Cyberful's application services into one managed runtime and
// preserves the current project instance across every supported run boundary.
// → cyberful/src/project/instance-layer.ts — supplies project-scoped services.
// → cyberful/src/effect/observability.ts — installs local-only application logging.
// ────────────────────────────────────────────────────────────────────

import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@/effect/observability"

import { AppFileSystem } from "@/effect/filesystem"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@/file/ripgrep"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { SessionVariable } from "@/session/variable"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Reference } from "@/reference/reference"
import { Pty } from "@/pty"
import { PtyTicket } from "@/pty/ticket"
import { SyncEvent } from "@/sync"
import { Npm } from "@/dependency/npm"
import { memoMap } from "@/effect/memo-map"
import { DataMigration } from "@/data-migration"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"

const CoreAppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  AppFileSystem.defaultLayer,
  Bus.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Ripgrep.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
)

const SessionAppLayer = Layer.mergeAll(
  Question.defaultLayer,
  Todo.defaultLayer,
  SessionVariable.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  RuntimeFlags.defaultLayer,
  SessionRunState.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.defaultLayer,
  Command.defaultLayer,
)

const PlatformAppLayer = Layer.mergeAll(
  Truncate.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Reference.defaultLayer,
  Pty.defaultLayer,
  PtyTicket.defaultLayer,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
  DataMigration.defaultLayer,
)

export const AppLayer = Layer.mergeAll(CoreAppLayer, SessionAppLayer, PlatformAppLayer).pipe(
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
)

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(attach(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(attach(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(attach(effect), options)
  },
  runFork(effect) {
    return rt.runFork(attach(effect))
  },
  runCallback(effect) {
    return rt.runCallback(attach(effect))
  },
  dispose: () => rt.dispose(),
}
