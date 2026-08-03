// ── Formatter Capability Catalog ─────────────────────────────────
// Detects project-supported formatters and returns argument arrays that format
// one concrete file without invoking an intermediary shell.
// → cyberful/src/format/index.ts — caches detection and executes selected commands.
// → cyberful/src/dependency/npm.ts — resolves isolated JavaScript formatter binaries.
// ─────────────────────────────────────────────────────────────────

import { Npm } from "@/dependency/npm"
import type { InstanceContext } from "../project/instance-context"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { which } from "../util/which"
import { isRecord } from "@/util/record"

export interface Context extends Pick<InstanceContext, "directory" | "worktree"> {
  experimentalOxfmt: boolean
}

export interface Info {
  name: string
  environment?: Record<string, string>
  extensions: string[]
  enabled(context: Context): Promise<string[] | false>
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function hasDependency(manifest: unknown, section: string, dependency: string) {
  return typeof asRecord(asRecord(manifest)[section])[dependency] === "string"
}

function executableFormatter(name: string, extensions: string[], args: string[], executable = name): Info {
  return {
    name,
    extensions,
    async enabled() {
      const match = which(executable)
      return match ? [match, ...args] : false
    },
  }
}

export const gofmt = executableFormatter("gofmt", [".go"], ["-w", "$FILE"])

export const mix = executableFormatter(
  "mix",
  [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"],
  ["format", "$FILE"],
)

export const prettier: Info = {
  name: "prettier",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".graphql",
    ".gql",
  ],
  async enabled(context) {
    const items = await Filesystem.findUp("package.json", context.directory, context.worktree)
    for (const item of items) {
      const manifest = await Filesystem.readJson(item)
      if (
        hasDependency(manifest, "dependencies", "prettier") ||
        hasDependency(manifest, "devDependencies", "prettier")
      ) {
        const bin = await Npm.which("prettier")
        if (bin) return [bin, "--write", "$FILE"]
      }
    }
    return false
  },
}

export const oxfmt: Info = {
  name: "oxfmt",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
  async enabled(context) {
    if (!context.experimentalOxfmt) return false
    const items = await Filesystem.findUp("package.json", context.directory, context.worktree)
    for (const item of items) {
      const manifest = await Filesystem.readJson(item)
      if (hasDependency(manifest, "dependencies", "oxfmt") || hasDependency(manifest, "devDependencies", "oxfmt")) {
        const bin = await Npm.which("oxfmt")
        if (bin) return [bin, "$FILE"]
      }
    }
    return false
  },
}

export const biome: Info = {
  name: "biome",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".graphql",
    ".gql",
  ],
  async enabled(context) {
    const configs = ["biome.json", "biome.jsonc"]
    for (const config of configs) {
      const found = await Filesystem.findUp(config, context.directory, context.worktree)
      if (found.length > 0) {
        const bin = await Npm.which("@biomejs/biome")
        if (bin) return [bin, "format", "--write", "$FILE"]
      }
    }
    return false
  },
}

export const zig = executableFormatter("zig", [".zig", ".zon"], ["fmt", "$FILE"])

export const clang: Info = {
  name: "clang-format",
  extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino", ".C", ".H"],
  async enabled(context) {
    const items = await Filesystem.findUp(".clang-format", context.directory, context.worktree)
    if (items.length > 0) {
      const match = which("clang-format")
      if (match) return [match, "-i", "$FILE"]
    }
    return false
  },
}

export const ktlint = executableFormatter("ktlint", [".kt", ".kts"], ["-F", "$FILE"])

export const ruff: Info = {
  name: "ruff",
  extensions: [".py", ".pyi"],
  async enabled(context) {
    if (!which("ruff")) return false
    const configs = ["pyproject.toml", "ruff.toml", ".ruff.toml"]
    for (const config of configs) {
      const found = await Filesystem.findUp(config, context.directory, context.worktree)
      if (found.length > 0) {
        if (config === "pyproject.toml") {
          const content = await Filesystem.readText(found[0])
          if (content.includes("[tool.ruff]")) return ["ruff", "format", "$FILE"]
        } else {
          return ["ruff", "format", "$FILE"]
        }
      }
    }
    const deps = ["requirements.txt", "pyproject.toml", "Pipfile"]
    for (const dep of deps) {
      const found = await Filesystem.findUp(dep, context.directory, context.worktree)
      if (found.length > 0) {
        const content = await Filesystem.readText(found[0])
        if (content.includes("ruff")) return ["ruff", "format", "$FILE"]
      }
    }
    return false
  },
}

export const rlang: Info = {
  name: "air",
  extensions: [".R"],
  async enabled() {
    const air = which("air")
    if (air == null) return false

    const output = await Process.text([air, "--help"], { nothrow: true })

    // Check for "Air: An R language server and formatter"
    const firstLine = output.text.split("\n")[0]
    const hasR = firstLine.includes("R language")
    const hasFormatter = firstLine.includes("formatter")
    if (output.code === 0 && hasR && hasFormatter) return [air, "format", "$FILE"]
    return false
  },
}

export const uvformat: Info = {
  name: "uv",
  extensions: [".py", ".pyi"],
  async enabled(context) {
    if (await ruff.enabled(context)) return false
    const uv = which("uv")
    if (uv == null) return false
    const output = await Process.run([uv, "format", "--help"], { nothrow: true })
    if (output.code === 0) return [uv, "format", "--", "$FILE"]
    return false
  },
}

const rubyExtensions = [".rb", ".rake", ".gemspec", ".ru"]

export const rubocop = executableFormatter("rubocop", rubyExtensions, ["--autocorrect", "$FILE"])

export const standardrb = executableFormatter("standardrb", rubyExtensions, ["--fix", "$FILE"])

export const htmlbeautifier = executableFormatter("htmlbeautifier", [".erb", ".html.erb"], ["$FILE"])

export const dart = executableFormatter("dart", [".dart"], ["format", "$FILE"])

export const ocamlformat: Info = {
  name: "ocamlformat",
  extensions: [".ml", ".mli"],
  async enabled(context) {
    if (!which("ocamlformat")) return false
    const items = await Filesystem.findUp(".ocamlformat", context.directory, context.worktree)
    if (items.length > 0) return ["ocamlformat", "-i", "$FILE"]
    return false
  },
}

export const terraform = executableFormatter("terraform", [".tf", ".tfvars"], ["fmt", "$FILE"])

export const latexindent = executableFormatter("latexindent", [".tex"], ["-w", "-s", "$FILE"])

export const gleam = executableFormatter("gleam", [".gleam"], ["format", "$FILE"])

export const shfmt = executableFormatter("shfmt", [".sh", ".bash"], ["-w", "$FILE"])

export const nixfmt = executableFormatter("nixfmt", [".nix"], ["$FILE"])

export const rustfmt = executableFormatter("rustfmt", [".rs"], ["$FILE"])

export const pint: Info = {
  name: "pint",
  extensions: [".php"],
  async enabled(context) {
    const items = await Filesystem.findUp("composer.json", context.directory, context.worktree)
    for (const item of items) {
      const manifest = await Filesystem.readJson(item)
      if (hasDependency(manifest, "require", "laravel/pint") || hasDependency(manifest, "require-dev", "laravel/pint"))
        return ["./vendor/bin/pint", "$FILE"]
    }
    return false
  },
}

export const ormolu = executableFormatter("ormolu", [".hs"], ["-i", "$FILE"])

export const cljfmt = executableFormatter("cljfmt", [".clj", ".cljs", ".cljc", ".edn"], ["fix", "--quiet", "$FILE"])

export const dfmt = executableFormatter("dfmt", [".d"], ["-i", "$FILE"])
