#!/usr/bin/env bun
// ── Control-Plane Client Generation ──────────────────────────────
// Generates the typed client from the live server schema, applies guarded
// compatibility corrections, and removes unused output and the temporary spec.
// → cyberful/src/server/server.ts — publishes the source OpenAPI contract.
// → cyberful/src/server/client/gen/ — receives the generated client modules.
// ─────────────────────────────────────────────────────────────────

import { rm } from "node:fs/promises"
import path from "node:path"
import { createClient } from "@hey-api/openapi-ts"
import { Server } from "../src/server/server"

const root = path.resolve(import.meta.dir, "..")
const spec = path.join(root, ".openapi.json")
const output = path.join(root, "src/server/client/gen")
const unreferencedGeneratedFiles = new Set(["client/index.ts", "core/queryKeySerializer.gen.ts"])

type GeneratedHeader = {
  title: string
  prose: readonly [string, string]
}

const generatedHeaders: Record<string, GeneratedHeader> = {
  "client.gen.ts": {
    title: "Default Control-Plane Client",
    prose: [
      "Creates the default Fetch client configured for Cyberful's local control-plane",
      "base URL and exposes the configuration override used by SDK consumers.",
    ],
  },
  "sdk.gen.ts": {
    title: "Typed Control-Plane SDK",
    prose: [
      "Exposes one typed ControlPlaneClient method for each generated server endpoint",
      "and routes calls through either the supplied client or the local default client.",
    ],
  },
  "types.gen.ts": {
    title: "Control-Plane API Types",
    prose: [
      "Declares the request, response, error, event, and model types derived from the",
      "control-plane OpenAPI document consumed by the terminal client.",
    ],
  },
  "client/client.gen.ts": {
    title: "Fetch Request Pipeline",
    prose: [
      "Builds control-plane requests, applies interceptors, parses response bodies, and",
      "preserves network, HTTP, streaming, and cancellation outcomes for SDK callers.",
    ],
  },
  "client/index.ts": {
    title: "Generated Client Surface",
    prose: [
      "Re-exports the generated Fetch client contracts and serializers that form the",
      "public transport surface consumed by the control-plane SDK.",
    ],
  },
  "client/types.gen.ts": {
    title: "Fetch Client Contracts",
    prose: [
      "Models client configuration, request results, endpoint methods, middleware, and",
      "server-sent event operations for the generated Fetch transport.",
    ],
  },
  "client/utils.gen.ts": {
    title: "Fetch Client Configuration",
    prose: [
      "Builds URLs, merges headers and configuration, applies authentication, and owns",
      "the interceptor registries used by generated control-plane requests.",
    ],
  },
  "core/auth.gen.ts": {
    title: "Generated Authentication Parameters",
    prose: [
      "Resolves configured authentication tokens and places them in the header, query,",
      "or cookie location described by an OpenAPI security scheme.",
    ],
  },
  "core/bodySerializer.gen.ts": {
    title: "Generated Body Serializers",
    prose: [
      "Serializes JSON, form-data, and URL-encoded request bodies while preserving the",
      "query serializer contract shared by the generated transport.",
    ],
  },
  "core/params.gen.ts": {
    title: "Generated Request Parameters",
    prose: [
      "Maps flat SDK arguments into body, header, path, and query slots before the Fetch",
      "transport constructs a control-plane request.",
    ],
  },
  "core/pathSerializer.gen.ts": {
    title: "Generated Path Serialization",
    prose: [
      "Encodes primitive, array, and object parameters according to their OpenAPI path",
      "and query serialization styles.",
    ],
  },
  "core/queryKeySerializer.gen.ts": {
    title: "Generated Query-Key Normalization",
    prose: [
      "Normalizes supported JavaScript values into deterministic JSON-compatible shapes",
      "that generated query-key consumers can hash safely.",
    ],
  },
  "core/serverSentEvents.gen.ts": {
    title: "Generated Event Stream Transport",
    prose: [
      "Parses control-plane server-sent events and owns abort handling, bounded retry",
      "delays, reconnection state, validation, and async iteration.",
    ],
  },
  "core/types.gen.ts": {
    title: "Generated Transport Types",
    prose: [
      "Defines the transport, authentication, serialization, validation, and response",
      "contracts shared by the generated Fetch client modules.",
    ],
  },
  "core/utils.gen.ts": {
    title: "Generated URL Construction",
    prose: [
      "Expands path templates, serializes query parameters, and validates request bodies",
      "before they cross the Fetch boundary.",
    ],
  },
}

function generatedHeader(filePath: string) {
  const normalizedPath = filePath.replaceAll("\\", "/")
  const generatedFile = Object.keys(generatedHeaders)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalizedPath === candidate || normalizedPath.endsWith(`/${candidate}`))
  if (!generatedFile) {
    throw new Error(`Missing CODE.md header contract for generated client file: ${filePath}`)
  }

  const header = generatedHeaders[generatedFile]
  return [
    `// ── ${header.title} ${"─".repeat(Math.max(3, 58 - header.title.length))}`,
    ...header.prose.map((line) => `// ${line}`),
    "// → cyberful/script/generate-client.ts — regenerates and patches this module.",
    "// ─────────────────────────────────────────────────────────────────",
  ]
}

async function patchGeneratedFile(relativePath: string, replacements: ReadonlyArray<readonly [string, string]>) {
  const filePath = path.join(output, relativePath)
  let source = await Bun.file(filePath).text()
  for (const replacement of replacements) {
    if (!source.includes(replacement[0])) {
      throw new Error(`Generated compatibility patch did not apply; @hey-api output changed (${filePath})`)
    }
    source = source.replace(replacement[0], replacement[1])
  }
  await Bun.write(filePath, source)
}

async function applyGeneratedHeader(relativePath: string) {
  const filePath = path.join(output, relativePath)
  const source = await Bun.file(filePath).text()
  const expectedHeader = generatedHeader(relativePath).join("\n")
  if (source.startsWith(expectedHeader)) return

  const upstreamHeader = "// This file is auto-generated by @hey-api/openapi-ts"
  if (!source.startsWith(upstreamHeader)) {
    throw new Error(`Generated header patch did not apply; @hey-api output changed (${filePath})`)
  }
  await Bun.write(filePath, expectedHeader + source.slice(upstreamHeader.length))
}

async function formatGeneratedClient() {
  const formatter = Bun.spawn(["bun", "prettier", "--write", "--log-level=error", "src/server/client/gen"], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    maxBuffer: 2_097_152,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(formatter.stdout).text(),
    new Response(formatter.stderr).text(),
    formatter.exited,
  ])
  if (exitCode !== 0) {
    const detail = (stderr.trim() || stdout.trim()).slice(0, 2_000)
    throw new Error(`Generated client formatting failed with status ${exitCode}${detail ? `: ${detail}` : ""}`)
  }
}

await Bun.write(spec, JSON.stringify(await Server.openapi()))

try {
  await createClient({
    input: spec,
    output: {
      path: output,
      tsConfigPath: path.join(root, "tsconfig.json"),
      clean: true,
      header: (context) => generatedHeader(context.file.finalPath ?? context.file.logicalFilePath),
    },
    plugins: [
      {
        name: "@hey-api/typescript",
        exportFromIndex: false,
      },
      {
        name: "@hey-api/sdk",
        operations: {
          strategy: "single",
          containerName: "ControlPlaneClient",
          methods: "instance",
        },
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      {
        name: "@hey-api/client-fetch",
        exportFromIndex: false,
        baseUrl: "http://localhost:4096",
      },
    ],
  })

  await Promise.all([
    patchGeneratedFile("sdk.gen.ts", [
      [
        "import { buildClientParams, type Client, type Options as Options2, type TDataShape } from './client';",
        "import { buildClientParams } from './core/params.gen';\nimport type { Client, Options as Options2, TDataShape } from './client/types.gen';",
      ],
      ["No SDK client found", "No control-plane client found"],
    ]),
    patchGeneratedFile("client.gen.ts", [
      [
        "import { type ClientOptions, type Config, createClient, createConfig } from './client';",
        "import { createClient } from './client/client.gen';\nimport type { ClientOptions, Config } from './client/types.gen';\nimport { createConfig } from './client/utils.gen';",
      ],
    ]),
    patchGeneratedFile("client/types.gen.ts", [
      ["=> Promise<ServerSentEventsResult<TData, TError>>", "=> Promise<ServerSentEventsResult<TData>>"],
      [
        "type SseFn = <\n  TData = unknown,\n  TError = unknown,",
        "type SseFn = <\n  TData = unknown,\n  _TError = unknown,",
      ],
      ["  serializedBody?: string;", "  serializedBody?: BodyInit | null;"],
      [
        "          ) & {\n            request: Request;\n            response: Response;\n          }",
        "          ) & {\n            request: Request;\n            response: Response | undefined;\n          }",
      ],
    ]),
    patchGeneratedFile("core/bodySerializer.gen.ts", [
      [
        "export type BodySerializer = (body: any) => any;",
        "export type BodySerializer = (body: unknown) => BodyInit | null | undefined;",
      ],
      ["Record<string, any>", "Record<string, unknown>"],
      ["Record<string, any>", "Record<string, unknown>"],
      ["Record<string, any>", "Record<string, unknown>"],
      ["Record<string, any>", "Record<string, unknown>"],
    ]),
    patchGeneratedFile("client/utils.gen.ts", [
      ["  response: Res,\n  request: Req,", "  response: Res | undefined,\n  request: Req,"],
    ]),
    patchGeneratedFile("client/client.gen.ts", [
      ["  body?: any;", "  body?: BodyInit | null;"],
      [
        "  const beforeRequest = async (options: RequestOptions) => {\n    const opts = {",
        "  const beforeRequest = async (options: RequestOptions) => {\n    const opts: ResolvedRequestOptions & {\n      fetch: typeof fetch;\n      headers: Headers;\n    } = {",
      ],
      ["            undefined as any,", "            undefined,"],
      ["            response: undefined as any,", "            response: undefined,"],
      ["        let emptyData: any;", "        let emptyData: unknown;"],
      ["      let data: any;", "      let data: unknown;"],
      ["    const _fetch = opts.fetch!;", "    const _fetch = opts.fetch;"],
      [
        "    const textError = await response.text();\n    let jsonError: unknown;\n\n    try {\n      jsonError = JSON.parse(textError);\n    } catch {\n      // noop\n    }\n\n    const error = jsonError ?? textError;",
        "    const textError = await response.text();\n    let error: unknown;\n\n    try {\n      error = JSON.parse(textError);\n    } catch {\n      error = textError;\n    }",
      ],
      [
        "        finalError = (await fn(error, response, request, opts)) as string;",
        "        finalError = await fn(error, response, request, opts);",
      ],
      ["    finalError = finalError || ({} as string);", "    finalError ||= {};"],
      ["    // TODO: we probably want to return error and improve types\n", ""],
      [
        "  const request: Client['request'] = async (options) => {\n    // @ts-expect-error\n    const { opts, url } = await beforeRequest(options);",
        "  // ── OpenAPI Owns The Response Type Proof ────────────────────────\n  // The local server and this client are generated from the same OpenAPI document.\n  // Fetch returns unknown payloads, while endpoint methods expose document-derived\n  // response types that a shared runtime implementation cannot retain generically.\n  // The boundary assertion stays limited to this adapter; configured validators still\n  // run before transformed JSON leaves the transport path.\n  // ─────────────────────────────────────────────────────────────────\n  const requestImplementation = async (options: RequestOptions): Promise<unknown> => {\n    const { opts, url } = await beforeRequest(options);",
      ],
      [
        "  };\n\n  const makeMethodFn =",
        "  };\n  const request = requestImplementation as Client['request'];\n\n  const makeMethodFn =",
      ],
    ]),
    patchGeneratedFile("core/utils.gen.ts", [
      [
        "  serializedBody?: unknown;\n}) {\n  const hasBody = options.body !== undefined;\n  const isSerializedBody = hasBody && options.bodySerializer;\n\n  if (isSerializedBody) {",
        "  serializedBody?: BodyInit | null;\n}): BodyInit | null | undefined {\n  const hasBody = options.body !== undefined;\n\n  if (hasBody && options.bodySerializer) {\n    const bodySerializer = options.bodySerializer;",
      ],
      [
        "    // not all clients implement a serializedBody property (i.e. client-axios)\n    return options.body !== '' ? options.body : null;",
        "    // not all clients precompute a serializedBody property (i.e. client-axios)\n    return options.body !== '' ? bodySerializer(options.body) : null;",
      ],
      [
        "  // plain/text body\n  if (hasBody) {\n    return options.body;\n  }",
        "  // A body without a serializer must already satisfy Fetch's runtime contract.\n  if (hasBody) {\n    if (\n      options.body === null ||\n      typeof options.body === 'string' ||\n      options.body instanceof Blob ||\n      options.body instanceof ArrayBuffer ||\n      options.body instanceof FormData ||\n      options.body instanceof URLSearchParams ||\n      options.body instanceof ReadableStream\n    ) {\n      return options.body;\n    }\n    if (ArrayBuffer.isView(options.body) && options.body.buffer instanceof ArrayBuffer) {\n      // The ArrayBuffer proof excludes SharedArrayBuffer views, which Fetch does not accept as BodyInit.\n      return options.body as ArrayBufferView<ArrayBuffer>;\n    }\n    throw new TypeError('Request body requires a configured serializer');\n  }",
      ],
    ]),
    patchGeneratedFile("core/serverSentEvents.gen.ts", [
      [
        "        const abortHandler = () => {\n          try {\n            reader.cancel();\n          } catch {\n            // noop\n          }\n        };",
        "        let cancellation: Promise<void> | undefined;\n        const abortHandler = () => {\n          cancellation ??= reader.cancel();\n        };",
      ],
      [
        "          signal.removeEventListener('abort', abortHandler);\n          reader.releaseLock();",
        "          signal.removeEventListener('abort', abortHandler);\n          try {\n            await cancellation;\n          } finally {\n            reader.releaseLock();\n          }",
      ],
      [
        "        onSseError?.(error);\n\n        if (",
        "        onSseError?.(error);\n\n        if (signal.aborted) break;\n\n        if (",
      ],
      [
        "                yield data as any;",
        "                yield data as TData extends Record<string, unknown>\n                  ? TData[keyof TData]\n                  : TData;",
      ],
    ]),
    patchGeneratedFile("core/params.gen.ts", [
      [
        "        const field = map.get(config.key)!;\n        const name = field.map || config.key;",
        "        const field = map.get(config.key);\n        if (!field) {\n          continue;\n        }\n        const name = field.map || config.key;",
      ],
    ]),
  ])
  await Promise.all(
    Object.keys(generatedHeaders)
      .filter((relativePath) => !unreferencedGeneratedFiles.has(relativePath))
      .map((relativePath) => applyGeneratedHeader(relativePath)),
  )
  await Promise.all(
    [...unreferencedGeneratedFiles].map((relativePath) => rm(path.join(output, relativePath), { force: true })),
  )
  await formatGeneratedClient()
} finally {
  await rm(spec, { force: true })
}
