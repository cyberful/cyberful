// ── Managed EVM Lab Tests ───────────────────────────────────────────────────
// Exercises lifecycle, endpoints, synthetic variables, fork redaction, and
// snapshots through injected Docker/RPC boundaries without a live daemon.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { handleEvmLab, type EvmLabHooks } from "./evm-lab"

let root = ""
let previousWorkarea: string | undefined
let previousRuntime: string | undefined
let previousSession: string | undefined
let previousImage: string | undefined
const runtime = "11111111-2222-4333-8444-555555555555"

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-evm-lab-"))
  previousWorkarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  previousRuntime = process.env.CYBERFUL_EVM_RUNTIME_ID
  previousSession = process.env.CYBERFUL_SUBSYSTEM_SESSION
  previousImage = process.env.CYBERFUL_OS_IMAGE
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = root
  process.env.CYBERFUL_EVM_RUNTIME_ID = runtime
  process.env.CYBERFUL_SUBSYSTEM_SESSION = "ses_evm_test"
  process.env.CYBERFUL_OS_IMAGE = "cyberful-os:test"
})

afterEach(async () => {
  if (previousWorkarea === undefined) delete process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  else process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = previousWorkarea
  if (previousRuntime === undefined) delete process.env.CYBERFUL_EVM_RUNTIME_ID
  else process.env.CYBERFUL_EVM_RUNTIME_ID = previousRuntime
  if (previousSession === undefined) delete process.env.CYBERFUL_SUBSYSTEM_SESSION
  else process.env.CYBERFUL_SUBSYSTEM_SESSION = previousSession
  if (previousImage === undefined) delete process.env.CYBERFUL_OS_IMAGE
  else process.env.CYBERFUL_OS_IMAGE = previousImage
  await rm(root, { recursive: true, force: true })
})

function fixture() {
  const calls: string[][] = []
  const variables = new Map<string, string>()
  let snapshot = 0
  let container = ""
  const hooks: EvmLabHooks = {
    docker: async (args) => {
      calls.push([...args])
      if (args[0] === "run") {
        container = String(args[args.indexOf("--name") + 1])
        return { exitCode: 0, stdout: `${container}\n`, stderr: "" }
      }
      if (args[0] === "port") return { exitCode: 0, stdout: "127.0.0.1:45678\n", stderr: "" }
      if (args[0] === "logs")
        return {
          exitCode: 0,
          stdout:
            "Available Accounts\n" +
            "(0) 0x1111111111111111111111111111111111111111\n" +
            "(1) 0x2222222222222222222222222222222222222222\n" +
            "Private Keys\n" +
            `(0) 0x${"a".repeat(64)}\n` +
            `(1) 0x${"b".repeat(64)}\n`,
          stderr: "",
        }
      if (args[0] === "inspect") return { exitCode: 0, stdout: `${runtime} true\n`, stderr: "" }
      if (args[0] === "rm") return { exitCode: 0, stdout: `${container}\n`, stderr: "" }
      throw new Error(`unexpected Docker fixture call: ${args.join(" ")}`)
    },
    rpc: async (_url, method) => {
      if (method === "eth_chainId") return "0x7a69"
      if (method === "evm_snapshot") return `0x${(++snapshot).toString(16)}`
      if (method === "evm_revert") return true
      throw new Error(`unexpected RPC method ${method}`)
    },
    materialize: async () => [
      {
        repository: "contracts",
        url: "https://github.com/example/contracts.git",
        commit: "c".repeat(40),
        source_tree_sha256: "d".repeat(64),
        materialized_sha256: "e".repeat(64),
        file_count: 2,
        project_path: ".cyberful-evm/projects/lab/contracts",
        container_path: "/workspace/.cyberful-evm/projects/lab/contracts",
        submodules: [],
      },
    ],
    setVariable: (name, value, description) => variables.set(name, `${value}:${description}`),
    deleteVariable: (name) => {
      variables.delete(name)
    },
  }
  return { calls, variables, hooks }
}

describe("managed EVM lab", () => {
  test("prepares one loopback Anvil chain and supports snapshot, revert, status, and stop", async () => {
    const testRuntime = fixture()
    const prepared = await handleEvmLab(
      { action: "prepare", mode: "fresh", repositories: ["contracts"], chain_id: 31337, accounts: 2 },
      testRuntime.hooks,
    )
    expect(prepared).toMatchObject({
      status: "running",
      mode: "fresh",
      host_rpc_url: "http://127.0.0.1:45678",
      container_rpc_url: "http://host.docker.internal:45678",
      chain_id: 31337,
      accounts: [
        { address: "0x1111111111111111111111111111111111111111" },
        { address: "0x2222222222222222222222222222222222222222" },
      ],
    })
    expect(testRuntime.variables.size).toBe(2)
    expect([...testRuntime.variables.values()].every((value) => value.includes(`runtime=${runtime}`))).toBe(true)
    const run = testRuntime.calls.find((call) => call[0] === "run") ?? []
    expect(run).toContain("127.0.0.1::8545")
    expect(run).toContain("--mnemonic-seed-unsafe")
    expect(run).not.toContain("--network=none")
    expect(run.join(" ")).not.toContain("proxy")

    expect(await handleEvmLab({ action: "status" }, testRuntime.hooks)).toMatchObject({ status: "running" })
    expect(await handleEvmLab({ action: "snapshot", name: "before-poc" }, testRuntime.hooks)).toMatchObject({
      name: "before-poc",
      snapshot: "0x2",
    })
    expect(await handleEvmLab({ action: "revert", name: "before-poc" }, testRuntime.hooks)).toMatchObject({
      reverted: true,
      snapshot: "0x3",
    })
    expect(await handleEvmLab({ action: "stop" }, testRuntime.hooks)).toMatchObject({ stopped: true })
    expect(testRuntime.variables.size).toBe(0)
  })

  test("passes fork authority directly to Anvil but persists only a redacted origin", async () => {
    const testRuntime = fixture()
    await handleEvmLab(
      {
        action: "prepare",
        mode: "fork",
        repositories: ["contracts"],
        fork_url: "https://secret-token@rpc.example.test/private?api_key=secret",
        fork_block: 123456,
        accounts: 2,
      },
      testRuntime.hooks,
    )
    const run = testRuntime.calls.find((call) => call[0] === "run") ?? []
    expect(run).toContain("--fork-url")
    expect(run).toContain("https://secret-token@rpc.example.test/private?api_key=secret")
    const persisted = await readFile(path.join(root, "raw", "evm", "lab.json"), "utf8")
    expect(persisted).toContain('"origin": "https://rpc.example.test/[redacted]"')
    expect(persisted).not.toContain("secret-token")
    expect(persisted).not.toContain("api_key=secret")
  })
})
