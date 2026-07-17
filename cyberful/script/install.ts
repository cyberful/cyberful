// ── Per-User Cyberful Installation ──────────────────────────────────
// Builds the current platform binary, installs it below the user's Cyberful
// directory, and idempotently adds that directory to the active shell's PATH.
// It performs no privileged or system-wide writes on macOS, Linux, or Windows.
// → cyberful/script/build.ts — produces the host-specific standalone binary.
// ────────────────────────────────────────────────────────────────────

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const packageDir = path.resolve(import.meta.dir, "..")
const isWindows = process.platform === "win32"
const binName = isWindows ? "cyberful.exe" : "cyberful"

if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
  throw new Error(`Cyberful installation is not supported on ${process.platform}`)
}
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(`Cyberful installation is not supported on ${process.arch}`)
}

const targetOs = isWindows ? "windows" : process.platform
const target = `cyberful-${targetOs}-${process.arch}`
const builtBinary = path.join(packageDir, "dist", target, "bin", binName)

const installDir = path.join(os.homedir(), ".cyberful", "bin")
const installedBinary = path.join(installDir, binName)

async function build() {
  console.log(`▸ Building ${target} (single platform)…`)

  // ── Installation Reuses The Developer Environment ─────────────────
  // The installer delegates compilation to the same build command used directly by
  // contributors. That command may require configured registries, proxies, compilers,
  // and certificate paths, so this trusted local child deliberately inherits the host
  // environment. A fixed deadline and inherited stdio keep failure owned and visible.
  // ────────────────────────────────────────────────────────────────
  const child = Bun.spawn(["bun", "run", "script/build.ts", "--single", "--skip-install"], {
    cwd: packageDir,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    timeout: 900_000,
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`Host build exited with status ${exitCode}`)
  if (!fs.existsSync(builtBinary)) {
    throw new Error(`Build did not produce ${builtBinary}`)
  }
}

function installBinary() {
  fs.mkdirSync(installDir, { recursive: true })
  const temporary = path.join(installDir, `.${binName}.${crypto.randomUUID()}.tmp`)
  try {
    fs.copyFileSync(builtBinary, temporary)
    if (!isWindows) fs.chmodSync(temporary, 0o755)
    fs.renameSync(temporary, installedBinary)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  console.log(`▸ Installed ${installedBinary}`)
}

function addToUnixPath() {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const configuredXdg = process.env.XDG_CONFIG_HOME?.trim()
  if (configuredXdg && !path.isAbsolute(configuredXdg)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path")
  }
  const xdgConfig = configuredXdg || path.join(home, ".config")
  const rc =
    shell === "fish"
      ? path.join(xdgConfig, "fish", "config.fish")
      : shell === "zsh"
        ? path.join(home, ".zshrc")
        : shell === "bash"
          ? path.join(home, ".bashrc")
          : path.join(home, ".profile")

  const existing = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : ""
  if (existing.includes(".cyberful/bin")) {
    console.log(`▸ PATH already configured in ${rc}`)
    return rc
  }

  const block =
    shell === "fish"
      ? `\n# cyberful\nfish_add_path "$HOME/.cyberful/bin"\n`
      : `\n# cyberful\nexport PATH="$HOME/.cyberful/bin:$PATH"\n`
  fs.mkdirSync(path.dirname(rc), { recursive: true })
  fs.appendFileSync(rc, block)
  console.log(`▸ Added ~/.cyberful/bin to PATH in ${rc}`)
  return rc
}

const WINDOWS_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
])

function windowsEnvironment(additional: Record<string, string> = {}) {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && WINDOWS_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value
  }
  return { ...environment, ...additional }
}

async function addToWindowsPath() {
  const query = Bun.spawn(
    ["powershell", "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"],
    { env: windowsEnvironment(), stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 1_048_576 },
  )
  const [queryOutput, queryError, queryExitCode] = await Promise.all([
    new Response(query.stdout).text(),
    new Response(query.stderr).text(),
    query.exited,
  ])
  if (queryExitCode !== 0) {
    throw new Error(`Unable to read the per-user Windows PATH: ${queryError.trim()}`)
  }
  const current = queryOutput.trim()
  if (current.toLowerCase().includes(".cyberful\\bin")) {
    console.log("▸ PATH already configured for this user")
    return
  }
  const sep = current && !current.endsWith(";") ? ";" : ""
  const next = `${current}${sep}${installDir}`
  const update = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "[Environment]::SetEnvironmentVariable('Path', $env:CYBERFUL_INSTALL_PATH, 'User')",
    ],
    {
      env: windowsEnvironment({ CYBERFUL_INSTALL_PATH: next }),
      stdout: "inherit",
      stderr: "inherit",
      timeout: 30_000,
    },
  )
  const updateExitCode = await update.exited
  if (updateExitCode !== 0) throw new Error(`Unable to update the per-user Windows PATH (${updateExitCode})`)
  console.log("▸ Added %USERPROFILE%\\.cyberful\\bin to your user PATH")
}

async function main() {
  await build()
  installBinary()

  if (isWindows) {
    await addToWindowsPath()
    console.log("\n✓ cyberful installed. Open a new terminal, then run: cyberful")
    return
  }

  const rc = addToUnixPath()
  console.log(`\n✓ cyberful installed. Restart your terminal or run: source ${rc.replace(os.homedir(), "~")}`)
  console.log("  Then run: cyberful")
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(`\n✗ Install failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
