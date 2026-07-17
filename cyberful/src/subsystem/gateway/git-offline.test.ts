// ── Offline Git Process Policy Tests ─────────────────────────────
// Proves that every pre-publish Git child receives a network-inert config and
// a small environment without proxy, credential, or config-injection values.
// → cyberful/src/subsystem/gateway/git-tools.ts — owns the tested process boundary.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { handleGitTool, offlineGitEnvironment, publishGitEnvironment, type GitToolHooks } from "./git-tools"
import { isRecord } from "@/util/record"

const hooks: GitToolHooks = {
  confirmPublish: async () => false,
  fixedFindings: async () => ({ ok: true, unresolved: [] }),
}

function resultPath(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string") throw new Error(`Git tool result has no ${field}`)
  return value[field]
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function run(argv: readonly string[], cwd: string) {
  const child = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}

function restoreEnvironment(previous: ReadonlyMap<string, string | undefined>) {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

describe("offline Git environment", () => {
  test("allowlists operating-system context and removes network and credential inputs", () => {
    const environment = offlineGitEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LC_ALL: "C",
      GIT_ALLOW_PROTOCOL: "https:ssh",
      HTTP_PROXY: "http://proxy.invalid",
      https_proxy: "http://proxy.invalid",
      ALL_PROXY: "socks5://proxy.invalid",
      NO_PROXY: "*",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "malicious-helper",
      GIT_CONFIG_GLOBAL: "/tmp/injected-config",
      GIT_DIR: "/tmp/other-repository",
      GIT_ASKPASS: "/tmp/askpass",
      GIT_SSH_COMMAND: "ssh -o ProxyCommand=malicious",
      SSH_ASKPASS: "/tmp/ssh-askpass",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "github-secret",
      GITHUB_TOKEN: "github-secret",
      GLAB_TOKEN: "gitlab-secret",
      GITLAB_TOKEN: "gitlab-secret",
      CYBERFUL_REMEDIATION_PROOF_KEY: "host-secret",
    })

    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LC_ALL: "C",
      GIT_ALLOW_PROTOCOL: "",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    })
    expect(offlineGitEnvironment({ Path: "C:\\safe\\bin", SystemRoot: "C:\\Windows" })).toMatchObject({
      Path: "C:\\safe\\bin",
      SystemRoot: "C:\\Windows",
    })
    for (const name of [
      "HTTP_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "NO_PROXY",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_DIR",
      "GIT_ASKPASS",
      "GIT_SSH_COMMAND",
      "SSH_ASKPASS",
      "SSH_AUTH_SOCK",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GLAB_TOKEN",
      "GITLAB_TOKEN",
      "CYBERFUL_REMEDIATION_PROOF_KEY",
    ])
      expect(environment).not.toHaveProperty(name)
  })

  test("retains publish credentials and proxies but rejects config injection and proof secrets", () => {
    const environment = publishGitEnvironment({
      PATH: "/safe/bin",
      HTTP_PROXY: "http://approved-proxy.invalid",
      GH_TOKEN: "publish-token",
      SSH_AUTH_SOCK: "/tmp/publish-agent.sock",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://attacker.invalid/.insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/",
      CYBERFUL_REMEDIATION_PROOF_KEY: "host-proof-secret",
      CYBERFUL_CODE_GRAPH_LEDGER_KEY: "host-ledger-secret",
    })

    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HTTP_PROXY: "http://approved-proxy.invalid",
      GH_TOKEN: "publish-token",
      SSH_AUTH_SOCK: "/tmp/publish-agent.sock",
    })
    expect(environment).not.toHaveProperty("GIT_CONFIG_COUNT")
    expect(environment).not.toHaveProperty("GIT_CONFIG_KEY_0")
    expect(environment).not.toHaveProperty("GIT_CONFIG_VALUE_0")
    expect(environment).not.toHaveProperty("CYBERFUL_REMEDIATION_PROOF_KEY")
    expect(environment).not.toHaveProperty("CYBERFUL_CODE_GRAPH_LEDGER_KEY")
  })

  test("applies no-fetch, no-transport, no-filter and no-credential policy to every local Git child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-git-offline-"))
    const project = path.join(root, "project")
    const workarea = path.join(project, "work", "engagement")
    const bin = path.join(root, "bin")
    const filterMarker = path.join(root, "filter-invoked")
    const realGit = Bun.which("git")
    if (!realGit) throw new Error("Git is required for this test")
    const changedEnvironment = [
      "ALL_PROXY",
      "CYBERFUL_REMEDIATION_PROOF_KEY",
      "CYBERFUL_SUBSYSTEM_SOURCE_ROOT",
      "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT",
      "GH_TOKEN",
      "GITLAB_TOKEN",
      "GIT_ASKPASS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_SSH_COMMAND",
      "GITHUB_TOKEN",
      "GLAB_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "PATH",
      "SSH_ASKPASS",
      "SSH_AUTH_SOCK",
      "http_proxy",
      "https_proxy",
    ]
    const previous = new Map(changedEnvironment.map((name) => [name, process.env[name]]))

    try {
      await Promise.all([mkdir(workarea, { recursive: true }), mkdir(bin)])
      await run([realGit, "init", "--initial-branch=main", project], root)
      await run([realGit, "config", "user.name", "Cyberful Offline Test"], project)
      await run([realGit, "config", "user.email", "offline@example.invalid"], project)
      await writeFile(path.join(project, ".gitignore"), "/work/\n")
      await writeFile(path.join(project, ".gitattributes"), "*.bin filter=lfs\n*.probe filter=egress\n")
      await writeFile(path.join(project, "artifact.bin"), "local artifact\n")
      await writeFile(path.join(project, "artifact.probe"), "custom filtered artifact\n")
      await writeFile(path.join(project, "service.ts"), "export const value = 1\n")
      await run([realGit, "add", "."], project)
      await run([realGit, "commit", "-m", "initial"], project)
      const committedArtifact = await run([realGit, "show", "HEAD:artifact.bin"], project)

      const blockingFilter = path.join(bin, "blocking-filter")
      await writeFile(blockingFilter, `#!/bin/sh\necho invoked >> ${shellQuote(filterMarker)}\nexit 89\n`)
      await chmod(blockingFilter, 0o700)
      for (const key of ["filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process"])
        await run([realGit, "config", key, blockingFilter], project)
      await run([realGit, "config", "filter.lfs.required", "true"], project)
      for (const key of ["filter.egress.clean", "filter.egress.smudge", "filter.egress.process"])
        await run([realGit, "config", key, blockingFilter], project)
      await run([realGit, "config", "filter.egress.required", "true"], project)

      const gitWrapper = path.join(bin, "git")
      await writeFile(
        gitWrapper,
        [
          "#!/bin/sh",
          'fail() { echo "offline Git policy missing: $1" >&2; exit 91; }',
          'has_argument() { expected="$1"; shift; for argument in "$@"; do [ "$argument" = "$expected" ] && return 0; done; return 1; }',
          '[ "${GIT_NO_LAZY_FETCH:-}" = "1" ] || fail GIT_NO_LAZY_FETCH',
          '[ "${GIT_LFS_SKIP_SMUDGE:-}" = "1" ] || fail GIT_LFS_SKIP_SMUDGE',
          '[ -n "${GIT_ALLOW_PROTOCOL+x}" ] && [ -z "$GIT_ALLOW_PROTOCOL" ] || fail GIT_ALLOW_PROTOCOL',
          '[ "${GIT_TERMINAL_PROMPT:-}" = "0" ] || fail GIT_TERMINAL_PROMPT',
          '[ "${GCM_INTERACTIVE:-}" = "never" ] || fail GCM_INTERACTIVE',
          '[ -z "${HTTP_PROXY+x}" ] || fail HTTP_PROXY',
          '[ -z "${HTTPS_PROXY+x}" ] || fail HTTPS_PROXY',
          '[ -z "${http_proxy+x}" ] || fail http_proxy',
          '[ -z "${https_proxy+x}" ] || fail https_proxy',
          '[ -z "${ALL_PROXY+x}" ] || fail ALL_PROXY',
          '[ -z "${NO_PROXY+x}" ] || fail NO_PROXY',
          '[ -z "${GIT_CONFIG_COUNT+x}" ] || fail GIT_CONFIG_COUNT',
          '[ -z "${GIT_CONFIG_KEY_0+x}" ] || fail GIT_CONFIG_KEY_0',
          '[ -z "${GIT_CONFIG_VALUE_0+x}" ] || fail GIT_CONFIG_VALUE_0',
          '[ -z "${GIT_ASKPASS+x}" ] || fail GIT_ASKPASS',
          '[ -z "${GIT_SSH_COMMAND+x}" ] || fail GIT_SSH_COMMAND',
          '[ -z "${SSH_ASKPASS+x}" ] || fail SSH_ASKPASS',
          '[ -z "${SSH_AUTH_SOCK+x}" ] || fail SSH_AUTH_SOCK',
          '[ -z "${GH_TOKEN+x}" ] || fail GH_TOKEN',
          '[ -z "${GITHUB_TOKEN+x}" ] || fail GITHUB_TOKEN',
          '[ -z "${GLAB_TOKEN+x}" ] || fail GLAB_TOKEN',
          '[ -z "${GITLAB_TOKEN+x}" ] || fail GITLAB_TOKEN',
          '[ -z "${CYBERFUL_REMEDIATION_PROOF_KEY+x}" ] || fail CYBERFUL_REMEDIATION_PROOF_KEY',
          'for required in "protocol.allow=never" "protocol.file.allow=never" "protocol.ext.allow=never" "protocol.git.allow=never" "protocol.http.allow=never" "protocol.https.allow=never" "protocol.ssh.allow=never" "credential.helper=" "credential.interactive=false" "core.askPass=" "core.fsmonitor=false" "filter.lfs.clean=" "filter.lfs.smudge=" "filter.lfs.process=" "filter.lfs.required=false" "filter.egress.clean=" "filter.egress.smudge=" "filter.egress.process=" "filter.egress.required=false" "maintenance.auto=false" "gc.auto=0" "commit.gpgsign=false"; do has_argument "$required" "$@" || fail "$required"; done',
          `exec ${shellQuote(realGit)} "$@"`,
          "",
        ].join("\n"),
      )
      await chmod(gitWrapper, 0o700)

      Object.assign(process.env, {
        ALL_PROXY: "socks5://proxy.invalid",
        CYBERFUL_REMEDIATION_PROOF_KEY: "offline-test-proof-key-at-least-thirty-two-characters",
        CYBERFUL_SUBSYSTEM_SOURCE_ROOT: project,
        CYBERFUL_SUBSYSTEM_WORKAREA_ROOT: workarea,
        GH_TOKEN: "github-secret",
        GITLAB_TOKEN: "gitlab-secret",
        GIT_ASKPASS: blockingFilter,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: blockingFilter,
        GIT_SSH_COMMAND: `${blockingFilter} ssh`,
        GITHUB_TOKEN: "github-secret",
        GLAB_TOKEN: "gitlab-secret",
        HTTP_PROXY: "http://proxy.invalid",
        HTTPS_PROXY: "http://proxy.invalid",
        NO_PROXY: "*",
        PATH: `${bin}${path.delimiter}${previous.get("PATH") ?? ""}`,
        SSH_ASKPASS: blockingFilter,
        SSH_AUTH_SOCK: path.join(root, "agent.sock"),
        http_proxy: "http://proxy.invalid",
        https_proxy: "http://proxy.invalid",
      })

      await writeFile(path.join(project, "service.ts"), "export const value = eval(input)\n")
      const review = await handleGitTool("ses_offline_review", "review_prepare", {}, hooks)
      expect(await readFile(path.join(workarea, resultPath(review, "patch_path")), "utf8")).toContain("eval(input)")

      const remediation = await handleGitTool(
        "ses_offline_remediation",
        "remediation_prepare",
        { slug: "offline" },
        hooks,
      )
      const checkout = resultPath(remediation, "checkout")
      expect((await readFile(path.join(workarea, checkout, "artifact.bin"), "utf8")).trim()).toBe(committedArtifact)
      expect(await readFile(path.join(workarea, checkout, "artifact.probe"), "utf8")).toBe("custom filtered artifact\n")
      await expect(readFile(filterMarker, "utf8")).rejects.toThrow()
    } finally {
      restoreEnvironment(previous)
      await rm(root, { recursive: true, force: true })
    }
  })
})
