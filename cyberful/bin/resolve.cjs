// ── npm Binary Resolution ────────────────────────────────────────
// Detects the host platform, architecture, libc, and AVX2 capability, maps that
// runtime to a published optional package, and searches ancestors for its binary.
// → cyberful/bin/cyberful — launches the resolved executable and forwards signals.
// → cyberful/script/package-npm.ts — defines the matching platform package names.
// ─────────────────────────────────────────────────────────────────

const childProcess = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const platformNames = { darwin: "darwin", linux: "linux", win32: "windows" }
const architectureNames = { x64: "x64", arm64: "arm64" }
const probeOutputLimitBytes = 64 * 1024

function platformName(platform = os.platform()) {
  return platformNames[platform]
}

function architectureName(architecture = os.arch()) {
  return architectureNames[architecture]
}

function isMusl(platform = os.platform()) {
  if (platform !== "linux") return false
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Fall through to ldd detection.
  }
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], {
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: probeOutputLimitBytes,
    })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function supportsAvx2(platform = platformName(), architecture = architectureName()) {
  if (architecture !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
        maxBuffer: probeOutputLimitBytes,
      })
      return result.status === 0 && (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }
  if (platform !== "windows") return false

  const command =
    '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
  for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
    try {
      const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: probeOutputLimitBytes,
        windowsHide: true,
      })
      if (result.status !== 0) continue
      const output = (result.stdout || "").trim().toLowerCase()
      if (output === "true" || output === "1") return true
      if (output === "false" || output === "0") return false
    } catch {
      // Try the next PowerShell executable.
    }
  }
  return false
}

function target(
  platform = platformName(),
  architecture = architectureName(),
  musl = isMusl(),
  avx2 = supportsAvx2(platform, architecture),
) {
  if (!platform || !architecture) return
  if (platform === "linux" && musl) return
  if (architecture === "arm64" && platform !== "darwin") return
  return {
    packageName: `@cyberful/cli-${platform}-${architecture}`,
    binaryName: `cyberful${architecture === "x64" && !avx2 ? "-baseline" : ""}${platform === "windows" ? ".exe" : ""}`,
  }
}

function findBinary(startDirectory, packageName, binaryName) {
  let current = startDirectory
  for (;;) {
    const candidate = path.join(current, "node_modules", ...packageName.split("/"), "bin", binaryName)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function resolveBinary(startDirectory) {
  const selected = target()
  if (!selected) return
  return findBinary(startDirectory, selected.packageName, selected.binaryName)
}

function missingBinaryMessage() {
  const selected = target()
  if (!selected) return `Cyberful does not publish a binary for ${os.platform()} ${os.arch()}.`
  return `The Cyberful binary ${selected.binaryName} was not found in ${selected.packageName}. Reinstall @cyberful/cli with a supported npm client.`
}

module.exports = {
  architectureName,
  findBinary,
  isMusl,
  missingBinaryMessage,
  platformName,
  resolveBinary,
  supportsAvx2,
  target,
}
