// ── Cyberful-Owned Pi Credential Store ───────────────────────────
// Persists provider OAuth credentials outside settings.yaml and serializes
// refresh/login/logout across processes without exposing secrets to AgentRuns.
// → cyberful/src/subsystem/pi-models.ts — injects this store into Pi.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import type { Credential, CredentialInfo, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai"
import { Global } from "@/global"
import { Flock } from "@/util/flock"
import { isRecord } from "@/util/record"

function isOAuthCredential(value: unknown): value is OAuthCredential {
  return (
    isRecord(value) &&
    value.type === "oauth" &&
    typeof value.refresh === "string" &&
    typeof value.access === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  )
}

function isCredential(value: unknown): value is Credential {
  if (isOAuthCredential(value)) return true
  if (!isRecord(value) || value.type !== "api_key") return false
  if (value.key !== undefined && typeof value.key !== "string") return false
  return (
    value.env === undefined ||
    (isRecord(value.env) && Object.values(value.env).every((item) => typeof item === "string"))
  )
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file)
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Pi credential storage must be a regular file")
    if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) await chmod(file, 0o600)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

async function secureDirectory(file: string): Promise<boolean> {
  const directory = path.dirname(file)
  try {
    const entry = await lstat(directory)
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("Pi credential directory must be a non-symlink directory")
    if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) await chmod(directory, 0o700)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false
    throw error
  }
}

export class PiCredentialStore implements CredentialStore {
  readonly #file: string

  constructor(file = path.join(Global.Path.state, "pi-credentials.json")) {
    this.#file = file
  }

  async #withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const directory = path.dirname(this.#file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await secureDirectory(this.#file)
    return Flock.withLock(`pi-credentials:${this.#file}`, operation, {
      dir: path.join(directory, ".pi-credential-locks"),
    })
  }

  async #readAll(): Promise<Record<string, Credential>> {
    if (!(await secureDirectory(this.#file))) return {}
    if (!(await regularFile(this.#file))) return {}
    const parsed: unknown = JSON.parse(await readFile(this.#file, "utf8"))
    if (!isRecord(parsed)) throw new Error("Pi credential storage must contain a provider object")
    const result: Record<string, Credential> = {}
    for (const [providerID, credential] of Object.entries(parsed)) {
      if (!providerID.trim() || !isCredential(credential))
        throw new Error(`Pi credential storage contains an invalid entry for '${providerID}'`)
      result[providerID] = credential
    }
    return result
  }

  async #writeAll(credentials: Readonly<Record<string, Credential>>): Promise<void> {
    const directory = path.dirname(this.#file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await secureDirectory(this.#file)
    const temporary = path.join(directory, `.pi-credentials.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      await rename(temporary, this.#file)
      await chmod(this.#file, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.#readAll().then((credentials) => credentials[providerId])
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credentials = await this.#readAll()
    return Object.entries(credentials)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }))
      .toSorted((left, right) => left.providerId.localeCompare(right.providerId))
  }

  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#withWriteLock(async () => {
      const credentials = await this.#readAll()
      const next = await update(credentials[providerId])
      if (next === undefined) return credentials[providerId]
      if (!isCredential(next)) throw new Error(`Pi produced an invalid credential for '${providerId}'`)
      credentials[providerId] = next
      await this.#writeAll(credentials)
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.#withWriteLock(async () => {
      const credentials = await this.#readAll()
      if (!(providerId in credentials)) return
      delete credentials[providerId]
      await this.#writeAll(credentials)
    })
  }
}

export * as SubsystemPiCredentials from "./pi-credentials"
