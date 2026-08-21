#!/usr/bin/env bun
// ── First-Party agent-browser CAPTCHA Plugin ────────────────────────
// Implements agent-browser.plugin.v1 without a runtime dependency, maps a
// bounded generic request onto supported solver APIs, and returns only the
// solution needed by the active browser workflow. The plugin never navigates
// the target, mutates a browser session, or falls back to an unconfigured
// provider; Cyberful and agent-browser retain ownership of those boundaries.
// → cyberful/src/subsystem/gateway/server.ts — registers and gates the plugin.
// @docs/runtimes/browser.md
// ────────────────────────────────────────────────────────────────────

export const CAPTCHA_PLUGIN_PROTOCOL = "agent-browser.plugin.v1"
export const CAPTCHA_PLUGIN_VERSION = "0.1.0"
export const CAPTCHA_PLUGIN_CAPABILITIES = ["command.run", "captcha.solve"]

const MAX_INPUT_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 90_000
const MIN_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 3_000
const MAX_POLL_ATTEMPTS = 60

const PROVIDERS = {
  capsolver: {
    create: "https://api.capsolver.com/createTask",
    result: "https://api.capsolver.com/getTaskResult",
  },
  "2captcha": {
    create: "https://api.2captcha.com/createTask",
    result: "https://api.2captcha.com/getTaskResult",
  },
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`value must be an integer from ${minimum} through ${maximum}`)
  return value
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return undefined
  return requiredString(value, name)
}

function normalizedKind(value) {
  const kind = requiredString(value, "kind").toLowerCase().replaceAll("_", "-")
  const aliases = {
    turnstile: "turnstile",
    "cloudflare-turnstile": "turnstile",
    recaptcha: "recaptcha-v2",
    "recaptcha-v2": "recaptcha-v2",
    "recaptcha-v3": "recaptcha-v3",
    hcaptcha: "hcaptcha",
    "image-to-text": "image-to-text",
    image: "image-to-text",
  }
  const normalized = aliases[kind]
  if (!normalized)
    throw new Error("kind must be one of: turnstile, recaptcha-v2, recaptcha-v3, hcaptcha, image-to-text")
  return normalized
}

function checkedUrl(value) {
  const raw = requiredString(value, "url")
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error("url must be an absolute HTTP(S) URL")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("url must be an absolute HTTP(S) URL")
  return parsed.toString()
}

function genericTask(provider, request) {
  const kind = normalizedKind(request.kind)
  if (kind === "image-to-text") {
    const body = requiredString(request.body, "body")
    return {
      kind,
      task: {
        type: "ImageToTextTask",
        body,
        ...(optionalString(request.comment, "comment") ? { comment: request.comment.trim() } : {}),
      },
    }
  }

  const websiteURL = checkedUrl(request.url)
  const websiteKey = requiredString(request.siteKey, "siteKey")
  const action = optionalString(request.action, "action")
  const cdata = optionalString(request.cdata, "cdata")
  const pageData = optionalString(request.pageData ?? request.pagedata, "pageData")
  const invisible = typeof request.invisible === "boolean" ? request.invisible : undefined
  if (provider === "capsolver") {
    const type = {
      turnstile: "AntiTurnstileTaskProxyLess",
      "recaptcha-v2": "ReCaptchaV2TaskProxyLess",
      "recaptcha-v3": "ReCaptchaV3TaskProxyLess",
      hcaptcha: "HCaptchaTaskProxyless",
    }[kind]
    const metadata = {
      ...(action ? { action } : {}),
      ...(cdata ? { cdata } : {}),
    }
    return {
      kind,
      task: {
        type,
        websiteURL,
        websiteKey,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(kind === "recaptcha-v3" && action ? { pageAction: action } : {}),
        ...(kind === "recaptcha-v2" && invisible !== undefined ? { isInvisible: invisible } : {}),
      },
    }
  }

  const type = {
    turnstile: "TurnstileTaskProxyless",
    "recaptcha-v2": "RecaptchaV2TaskProxyless",
    "recaptcha-v3": "RecaptchaV3TaskProxyless",
    hcaptcha: "HCaptchaTaskProxyless",
  }[kind]
  return {
    kind,
    task: {
      type,
      websiteURL,
      websiteKey,
      ...(action ? { action } : {}),
      ...(cdata ? { data: cdata } : {}),
      ...(pageData ? { pagedata: pageData } : {}),
      ...(kind === "recaptcha-v3" && action ? { pageAction: action } : {}),
      ...(kind === "recaptcha-v2" && invisible !== undefined ? { isInvisible: invisible } : {}),
    },
  }
}

function providerTask(provider, request) {
  if (!isRecord(request)) throw new Error("captcha.solve request must be an object")
  if (request.task !== undefined) {
    if (!isRecord(request.task) || typeof request.task.type !== "string" || !request.task.type.trim())
      throw new Error("task must be an object with a non-empty type")
    return { kind: optionalString(request.kind, "kind") ?? "custom", task: request.task }
  }
  return genericTask(provider, request)
}

function configuredProvider(request, env) {
  const requested = optionalString(request.provider, "provider")?.toLowerCase()
  const configured = requested ?? optionalString(env.CYBER_BROWSER_CAPTCHA_PROVIDER, "CYBER_BROWSER_CAPTCHA_PROVIDER")?.toLowerCase() ?? "auto"
  if (configured !== "auto" && configured !== "capsolver" && configured !== "2captcha")
    throw new Error("CAPTCHA provider must be auto, capsolver, or 2captcha")
  const generic = optionalString(env.CYBER_BROWSER_CAPTCHA_API_KEY, "CYBER_BROWSER_CAPTCHA_API_KEY")
  const capsolver = optionalString(env.CAPSOLVER_API_KEY, "CAPSOLVER_API_KEY")
  const twoCaptcha = optionalString(env.TWOCAPTCHA_API_KEY, "TWOCAPTCHA_API_KEY")
  if (configured === "capsolver") return { provider: configured, key: generic ?? capsolver }
  if (configured === "2captcha") return { provider: configured, key: generic ?? twoCaptcha }
  if (capsolver) return { provider: "capsolver", key: capsolver }
  if (twoCaptcha) return { provider: "2captcha", key: twoCaptcha }
  if (generic)
    throw new Error("CYBER_BROWSER_CAPTCHA_PROVIDER is required when using CYBER_BROWSER_CAPTCHA_API_KEY")
  return { provider: "capsolver", key: undefined }
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("CAPTCHA provider response exceeded 1 MiB")
  if (!response.ok) throw new Error(`CAPTCHA provider returned HTTP ${response.status}`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("CAPTCHA provider returned malformed JSON")
  }
  if (!isRecord(parsed)) throw new Error("CAPTCHA provider returned a non-object response")
  return parsed
}

async function postJson(fetchImpl, url, body, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return readJsonResponse(response)
}

function providerError(response) {
  const errorID = response.errorId
  if (typeof errorID === "number" && errorID === 0) return
  const code = typeof response.errorCode === "string" ? response.errorCode : "PROVIDER_ERROR"
  const description = typeof response.errorDescription === "string" ? response.errorDescription : "provider rejected the task"
  throw new Error(`${code}: ${description}`)
}

function readySolution(response) {
  providerError(response)
  if (response.status !== "ready") return
  if (!isRecord(response.solution)) throw new Error("CAPTCHA provider returned ready without a solution")
  return response.solution
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// ── Solver Calls Are Finite And Provider-Pinned ────────────────────
// Only the two documented HTTPS endpoints can receive a request. The API key is
// read from process environment, never accepted in the model payload or returned
// in errors. Both each HTTP call and the whole polling loop are bounded.
// A failed or unavailable provider remains an explicit result for human fallback.
// ────────────────────────────────────────────────────────────────────
export async function solveCaptcha(request, options = {}) {
  if (!isRecord(request)) throw new Error("captcha.solve request must be an object")
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? delay
  const { provider, key } = configuredProvider(request, env)
  if (!key)
    throw new Error(
      `CAPTCHA solver '${provider}' is not configured; set CYBER_BROWSER_CAPTCHA_PROVIDER and CYBER_BROWSER_CAPTCHA_API_KEY`,
    )
  const { kind, task } = providerTask(provider, request)
  const timeoutMs = boundedInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const pollIntervalMs = boundedInteger(
    request.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    250,
    Math.min(10_000, timeoutMs),
  )
  const endpoints = PROVIDERS[provider]
  const started = Date.now()
  const remaining = () => Math.max(1, Math.min(20_000, timeoutMs - (Date.now() - started)))
  const created = await postJson(fetchImpl, endpoints.create, { clientKey: key, task }, remaining())
  const immediate = readySolution(created)
  if (immediate) return { provider, kind, solution: immediate }
  const taskID = created.taskId
  if ((typeof taskID !== "string" && typeof taskID !== "number") || String(taskID).length === 0)
    throw new Error("CAPTCHA provider did not return a taskId")

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    const elapsed = Date.now() - started
    if (elapsed + pollIntervalMs >= timeoutMs) throw new Error(`CAPTCHA solve timed out after ${timeoutMs}ms`)
    await sleep(pollIntervalMs)
    const result = await postJson(
      fetchImpl,
      endpoints.result,
      { clientKey: key, taskId: taskID },
      remaining(),
    )
    const solution = readySolution(result)
    if (solution) return { provider, kind, taskId: String(taskID), solution }
    if (result.status !== "processing" && result.status !== "idle")
      throw new Error(`CAPTCHA provider returned unexpected status '${String(result.status)}'`)
  }
  throw new Error("CAPTCHA solve exceeded the polling limit")
}

function protocolReply(success, response, error) {
  return {
    protocol: CAPTCHA_PLUGIN_PROTOCOL,
    success,
    ...(success ? { response } : { error }),
  }
}

export async function handlePluginRequest(input, options) {
  if (!isRecord(input) || input.protocol !== CAPTCHA_PLUGIN_PROTOCOL)
    return protocolReply(false, undefined, "unsupported or missing plugin protocol")
  if (input.type === "plugin.manifest") {
    return protocolReply(true, {
      name: "captcha",
      version: CAPTCHA_PLUGIN_VERSION,
      capabilities: CAPTCHA_PLUGIN_CAPABILITIES,
    })
  }
  if (input.type !== "captcha.solve" || input.capability !== "captcha.solve")
    return protocolReply(false, undefined, `unsupported request type '${String(input.type)}'`)
  try {
    return protocolReply(true, await solveCaptcha(input.request, options))
  } catch (error) {
    const message = error instanceof Error ? error.message : "CAPTCHA solver failed"
    return protocolReply(false, undefined, message.slice(0, 1_000))
  }
}

async function readStdin() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_INPUT_BYTES) throw new Error("plugin request exceeded 1 MiB")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function runCaptchaPlugin(argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    process.stdout.write(`agent-browser-plugin-captcha ${CAPTCHA_PLUGIN_VERSION}\n`)
    return
  }
  let reply
  try {
    const raw = await readStdin()
    reply = await handlePluginRequest(JSON.parse(raw))
  } catch (error) {
    reply = protocolReply(false, undefined, error instanceof Error ? error.message.slice(0, 1_000) : "invalid plugin request")
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`)
}

if (import.meta.main) await runCaptchaPlugin()
