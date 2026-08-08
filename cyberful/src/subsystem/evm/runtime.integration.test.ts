// ── Live EVM Runtime Contract ───────────────────────────────────────────────
// Exercises the production Bug Bounty core container, isolated compiler cache,
// hardened Anvil lifecycle, and host/container RPC routes against the built
// cyberful-os image without contacting an application target.
// → cyberful/src/subsystem/gateway/evm-lab.ts — owns the tested Anvil lifecycle.
// @docs/runtimes/evm.md
// ─────────────────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { lstat, mkdtemp, mkdir, realpath, rm } from "node:fs/promises"

const IMAGE = process.env.CYBERFUL_OS_IMAGE?.trim() || "cyberful-os:latest"
const ENVIRONMENT_KEYS = [
  "CYBERFUL_DB",
  "CYBERFUL_EVM_RUNTIME_ID",
  "CYBERFUL_OS_CONTAINER",
  "CYBERFUL_OS_IMAGE",
  "CYBERFUL_SUBSYSTEM_SESSION",
  "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
  "CYBER_BROWSER_MCP_ENABLED",
  "CYBER_ZAP_ENABLED",
] as const

async function docker(args: readonly string[], timeoutMs = 120_000) {
  const child = Bun.spawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0)
      throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || stdout.trim()}`)
    return stdout.trim()
  } finally {
    clearTimeout(timer)
  }
}

test("Bug Bounty reuses Solc offline and reaches a hardened fresh Anvil lab from cyberful-os", async () => {
  const previous = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true)
  const workarea = await mkdtemp(path.join(os.tmpdir(), "cyberful-evm-live-"))
  const canonicalWorkarea = await realpath(workarea)
  const sessionID = `ses_evm_live_${process.pid}`
  const container = `cyberful-evm-live-${process.pid}`
  let core: Awaited<ReturnType<typeof import("../engagement-runtime").SubsystemEngagementRuntime.startEngagement>> | undefined
  let evm: Awaited<ReturnType<typeof import("./runtime").SubsystemEvmRuntime.startEngagement>> | undefined
  let stopLab: (() => Promise<unknown>) | undefined

  process.env.CYBERFUL_DB = ":memory:"
  process.env.CYBERFUL_OS_IMAGE = IMAGE
  process.env.CYBERFUL_SUBSYSTEM_SESSION = sessionID
  process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT = workarea
  process.env.CYBER_BROWSER_MCP_ENABLED = "0"
  process.env.CYBER_ZAP_ENABLED = "0"

  try {
    const { SubsystemEngagementRuntime } = await import("../engagement-runtime")
    const { SubsystemEvmRuntime } = await import("./runtime")
    const { handleEvmLab } = await import("../gateway/evm-lab")

    core = await SubsystemEngagementRuntime.startEngagement({
      sessionID,
      workflow: "bug-bounty",
      container,
      workarea,
      objective: "Verify the local EVM runtime without target traffic.",
    })
    Object.assign(process.env, core.env)
    evm = await SubsystemEvmRuntime.startEngagement({ sessionID, workarea, container })
    Object.assign(process.env, evm.env)
    expect((await lstat(path.join(canonicalWorkarea, ".cyberful-evm", "cache"))).mode & 0o777).toBe(0o700)

    const variables = new Map<string, string>()
    const prepared = await handleEvmLab(
      { action: "prepare", mode: "fresh", repositories: ["contracts"], chain_id: 31337, accounts: 2 },
      {
        materialize: async (destination) => {
          const project = path.join(destination, "contracts")
          await mkdir(path.join(project, "src"), { recursive: true, mode: 0o700 })
          await Promise.all([
            Bun.write(
              path.join(project, "foundry.toml"),
              '[profile.default]\nsrc = "src"\nout = "out"\nsolc_version = "0.8.34"\nbuild_info = true\n',
            ),
            Bun.write(
              path.join(project, "src", "Probe.sol"),
              "// SPDX-License-Identifier: MIT\npragma solidity 0.8.34;\ncontract Probe { function answer() external pure returns (uint256) { return 42; } }\n",
            ),
          ])
          const projectPath = path.relative(canonicalWorkarea, project).replaceAll(path.sep, "/")
          return [{
            repository: "contracts",
            url: "https://github.com/example/contracts.git",
            commit: "c".repeat(40),
            source_tree_sha256: "d".repeat(64),
            materialized_sha256: "e".repeat(64),
            file_count: 2,
            project_path: projectPath,
            container_path: `/workspace/${projectPath}`,
            submodules: [],
          }]
        },
        setVariable: (name, value) => variables.set(name, value),
        deleteVariable: (name) => {
          variables.delete(name)
        },
      },
    )
    if (!("container_rpc_url" in prepared) || typeof prepared.container_rpc_url !== "string")
      throw new Error("live EVM lab returned no container RPC URL")
    if (!("repositories" in prepared) || !Array.isArray(prepared.repositories) || !prepared.repositories[0])
      throw new Error("live EVM lab returned no materialized repository")
    const repository = prepared.repositories[0]
    if (!repository || typeof repository.container_path !== "string")
      throw new Error("live EVM lab returned an invalid materialized repository")
    const labContainer = `cyberful-anvil-${prepared.lab_id.slice(0, 12)}`
    stopLab = () => handleEvmLab(
      { action: "stop" },
      {
        setVariable: (name, value) => variables.set(name, value),
        deleteVariable: (name) => {
          variables.delete(name)
        },
      },
    )

    expect(await docker(["exec", container, "cast", "chain-id", "--rpc-url", prepared.container_rpc_url])).toBe("31337")
    expect(await handleEvmLab(
      { action: "snapshot", name: "before-test" },
      { setVariable: () => undefined, deleteVariable: () => undefined },
    )).toMatchObject({ name: "before-test" })
    expect(await handleEvmLab(
      { action: "revert", name: "before-test" },
      { setVariable: () => undefined, deleteVariable: () => undefined },
    )).toMatchObject({ reverted: true })

    const [user, readOnly, mounts, port, network, coreNetworks] = await Promise.all([
      docker(["inspect", "--format", "{{.Config.User}}", labContainer]),
      docker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", labContainer]),
      docker(["inspect", "--format", "{{json .Mounts}}", labContainer]),
      docker(["port", labContainer, "8545/tcp"]),
      docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", labContainer]),
      docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]),
    ])
    expect(user).toMatch(/^\d+:\d+$/)
    expect(user).not.toBe("0:0")
    expect(readOnly).toBe("true")
    expect(JSON.parse(mounts)).toEqual([])
    expect(port).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(JSON.parse(coreNetworks)).toHaveProperty(network)
    expect(
      await docker([
        "network",
        "inspect",
        "--format",
        '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}',
        network,
      ]),
    ).toBe("false")

    const foundryEnvironment = [
      "HOME=/workspace/.cyberful-evm/cache",
      "FOUNDRY_DIR=/workspace/.cyberful-evm/cache/.foundry",
      "SVM_HOME=/workspace/.cyberful-evm/cache/.svm",
      "XDG_CACHE_HOME=/workspace/.cyberful-evm/cache/.cache",
    ]
    await docker([
      "exec",
      "-w",
      repository.container_path,
      ...foundryEnvironment.flatMap((value) => ["--env", value]),
      container,
      "forge",
      "build",
      "--build-info",
    ])
    const compiler = path.join(workarea, ".cyberful-evm", "cache", ".svm", "0.8.34", "solc-0.8.34")
    expect(await Bun.file(compiler).exists()).toBe(true)
    await docker([
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--mount",
      `type=bind,source=${workarea},target=/workspace`,
      "--workdir",
      repository.container_path,
      ...foundryEnvironment.flatMap((value) => ["--env", value]),
      "--entrypoint",
      "forge",
      IMAGE,
      "build",
      "--offline",
      "--force",
    ])

    await stopLab()
    stopLab = undefined
    expect(JSON.parse(await docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]))).not
      .toHaveProperty(network)
    expect(variables.size).toBe(0)
    await evm.stop()
    evm = undefined
    expect(await Bun.file(path.join(workarea, ".cyberful-evm", "cache")).exists()).toBe(false)
  } finally {
    if (stopLab) await stopLab().catch(() => undefined)
    if (evm) await evm.stop().catch(() => undefined)
    if (core) await core.stop().catch(() => undefined)
    await docker(["rm", "--force", "--volumes", container]).catch(() => undefined)
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    stderrWrite.mockRestore()
    await rm(workarea, { recursive: true, force: true })
  }
}, 300_000)
