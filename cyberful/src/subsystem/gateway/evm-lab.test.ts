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
let previousContainer: string | undefined
const runtime = "11111111-2222-4333-8444-555555555555"

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cyberful-evm-lab-"))
  previousWorkarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT
  previousRuntime = process.env.CYBERFUL_EVM_RUNTIME_ID
  previousSession = process.env.CYBERFUL_SUBSYSTEM_SESSION
  previousImage = process.env.CYBERFUL_OS_IMAGE
  previousContainer = process.env.CYBERFUL_OS_CONTAINER
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = root
  process.env.CYBERFUL_EVM_RUNTIME_ID = runtime
  process.env.CYBERFUL_SUBSYSTEM_SESSION = "ses_evm_test"
  process.env.CYBERFUL_OS_IMAGE = "cyberful-os:test"
  process.env.CYBERFUL_OS_CONTAINER = "cyberful-os-test"
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
  if (previousContainer === undefined) delete process.env.CYBERFUL_OS_CONTAINER
  else process.env.CYBERFUL_OS_CONTAINER = previousContainer
  await rm(root, { recursive: true, force: true })
})

function fixture(input: { readonly logs?: string } = {}) {
  const calls: string[][] = []
  const variables = new Map<string, string>()
  let snapshot = 0
  let container = ""
  const hooks: EvmLabHooks = {
    docker: async (args) => {
      calls.push([...args])
      if (args[0] === "network" && args[1] === "create") return { exitCode: 0, stdout: `${args.at(-1)}\n`, stderr: "" }
      if (args[0] === "network" && args[1] === "inspect")
        return { exitCode: 0, stdout: `${runtime}\n`, stderr: "" }
      if (args[0] === "network" && args[1] === "connect") return { exitCode: 0, stdout: "", stderr: "" }
      if (args[0] === "network" && args[1] === "disconnect") return { exitCode: 0, stdout: "", stderr: "" }
      if (args[0] === "network" && args[1] === "rm") return { exitCode: 0, stdout: `${args.at(-1)}\n`, stderr: "" }
      if (args[0] === "run") {
        container = String(args[args.indexOf("--name") + 1])
        return { exitCode: 0, stdout: `${container}\n`, stderr: "" }
      }
      if (args[0] === "port") return { exitCode: 0, stdout: "127.0.0.1:45678\n", stderr: "" }
      if (args[0] === "logs")
        return {
          exitCode: 0,
          stdout: input.logs ??
            "Available Accounts\n" +
              "(0) 0x1111111111111111111111111111111111111111\n" +
              "(1) 0x2222222222222222222222222222222222222222\n" +
              "Private Keys\n" +
              `(0) 0x${"a".repeat(64)}\n` +
              `(1) 0x${"b".repeat(64)}\n`,
          stderr: "",
        }
      if (args[0] === "exec") return { exitCode: 0, stdout: "31337\n", stderr: "" }
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
      chain_id: 31337,
      accounts: [
        { address: "0x1111111111111111111111111111111111111111" },
        { address: "0x2222222222222222222222222222222222222222" },
      ],
    })
    if (
      !("lab_id" in prepared) ||
      typeof prepared.lab_id !== "string" ||
      !("container_rpc_url" in prepared) ||
      typeof prepared.container_rpc_url !== "string"
    )
      throw new Error("prepared lab has no container route")
    expect(prepared.container_rpc_url).toBe(`http://cyberful-anvil-${prepared.lab_id.slice(0, 12)}:8545`)
    expect(testRuntime.variables.size).toBe(2)
    expect([...testRuntime.variables.values()].every((value) => value.includes(`runtime=${runtime}`))).toBe(true)
    const run = testRuntime.calls.find((call) => call[0] === "run") ?? []
    expect(run).toContain("127.0.0.1::8545")
    expect(run).toContain("--mnemonic-seed-unsafe")
    expect(run.slice(0, run.indexOf("cyberful-os:test"))).toContain("--entrypoint")
    expect(run[run.indexOf("--entrypoint") + 1]).toBe("anvil")
    expect(run.slice(run.indexOf("cyberful-os:test") + 1)).not.toContain("anvil")
    expect(run).toContain("--read-only")
    expect(run).toContain("HOME=/tmp")
    expect(run).toContain("/tmp:rw,noexec,nosuid,nodev,size=64m")
    expect(run).not.toContain("--mount")
    expect(run).toContain("--network")
    expect(run.join(" ")).not.toContain("proxy")
    const networkCreate = testRuntime.calls.find((call) => call[0] === "network" && call[1] === "create") ?? []
    expect(networkCreate).toContain("com.docker.network.bridge.enable_ip_masquerade=false")
    const network = String(networkCreate.at(-1))
    expect(testRuntime.calls).toContainEqual([
      "network",
      "connect",
      "--gw-priority=-1",
      network,
      "cyberful-os-test",
    ])
    expect(testRuntime.calls).toContainEqual([
      "exec",
      "cyberful-os-test",
      "cast",
      "chain-id",
      "--rpc-url",
      prepared.container_rpc_url,
    ])

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
    const disconnectIndex = testRuntime.calls.findIndex(
      (call) => call[0] === "network" && call[1] === "disconnect",
    )
    const removeIndex = testRuntime.calls.findIndex((call) => call[0] === "network" && call[1] === "rm")
    expect(disconnectIndex).toBeGreaterThan(-1)
    expect(removeIndex).toBeGreaterThan(disconnectIndex)
    expect(testRuntime.calls).toContainEqual([
      "exec",
      "cyberful-os-test",
      "rm",
      "--recursive",
      "--force",
      "--",
      `/workspace/.cyberful-evm/projects/${prepared.lab_id}`,
    ])
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
    expect(run).toContain("--network")
    const networkCreate = testRuntime.calls.find((call) => call[0] === "network" && call[1] === "create") ?? []
    expect(networkCreate).not.toContain("com.docker.network.bridge.enable_ip_masquerade=false")
    const persisted = await readFile(path.join(root, "raw", "evm", "lab.json"), "utf8")
    expect(persisted).toContain('"origin": "https://rpc.example.test/[redacted]"')
    expect(persisted).not.toContain("secret-token")
    expect(persisted).not.toContain("api_key=secret")
  })

  test("removes partial startup state and redacts a failed fork diagnostic", async () => {
    const forkUrl = "https://rpc.example.test/private?api_key=secret"
    const testRuntime = fixture({ logs: `fork initialization failed for ${forkUrl}\n` })
    let failure: unknown
    try {
      await handleEvmLab(
        {
          action: "prepare",
          mode: "fork",
          repositories: ["contracts"],
          fork_url: forkUrl,
          accounts: 2,
        },
        testRuntime.hooks,
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : ""
    expect(message).toContain("[redacted fork URL]")
    expect(message).not.toContain("api_key=secret")
    expect(testRuntime.calls.some((call) => call[0] === "rm" && call[1] === "--force")).toBe(true)
    expect(testRuntime.variables.size).toBe(0)
    expect(await Bun.file(path.join(root, "raw", "evm", "lab.json")).exists()).toBe(false)
  })
})
