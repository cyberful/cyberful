// ── ZAP Bridge Tool Catalog ──────────────────────────────────────
// Defines the bridge-owned MCP surface independently from connection and
// request execution. Official upstream tools are merged at runtime.
// ─────────────────────────────────────────────────────────────────

export const ZAP_BRIDGE_TOOLS = [
  {
    name: "zap_api_catalog",
    description: "List every API operation exposed by the installed ZAP core and add-ons.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: {
          type: "string",
          description: "Optional component filter, for example core, spider, websocket, or oast.",
        },
        type: { type: "string", enum: ["view", "action", "other"] },
      },
    },
  },
  {
    name: "zap_api_call",
    description: "Call any operation returned by zap_api_catalog without an additional host-owned scope policy.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: { type: "string" },
        type: { type: "string", enum: ["view", "action", "other"] },
        operation: { type: "string" },
        parameters: { type: "object", additionalProperties: true },
      },
      required: ["component", "type", "operation"],
    },
  },
  {
    name: "zap_http_request",
    description:
      "Send or replay one complete raw HTTP request through ZAP. Absolute-form HTTP(S) requests are accepted directly; origin-form requests require target_url and are normalized without guessing the scheme. Redirect handling is caller-selected.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        request: {
          type: "string",
          description: "Raw HTTP request including request line, headers, blank line, and optional body.",
        },
        target_url: {
          type: "string",
          description:
            "Exact absolute HTTP(S) destination. Required for origin-form request lines and, when supplied with absolute-form, must match exactly.",
        },
        follow_redirects: { type: "boolean", default: false },
      },
      required: ["request"],
    },
  },
  {
    name: "zap_generate_workarea_report",
    description:
      "Generate a ZAP report inside the engagement workarea from the complete ZAP session without filtering sites.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: { type: "string", description: "Path relative to the engagement root." },
        template: { type: "string", description: "Installed ZAP report template, for example traditional-json." },
        title: { type: "string" },
      },
      required: ["file_path", "template", "title"],
    },
  },
  {
    name: "zap_history_search",
    description:
      "Return a bounded metadata-only page of HTTP history, optionally scoped to a base URL and filtered by a case-insensitive text pattern. Request and response bodies are opt-in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        base_url: { type: "string" },
        start: { type: "integer", minimum: 0, default: 0 },
        count: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        search: { type: "string" },
        include_bodies: {
          type: "boolean",
          default: false,
          description: "Opt in to complete request/response pairs. Large results are stored once by content hash.",
        },
      },
    },
  },
  {
    name: "zap_history_get",
    description: "Read metadata for one ZAP history message. Request and response bodies are opt-in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { oneOf: [{ type: "integer" }, { type: "string" }] },
        include_bodies: {
          type: "boolean",
          default: false,
          description: "Opt in to the complete request/response pair. Large results are stored once by content hash.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "zap_history_replay",
    description:
      "Clone one captured HTTP history message and send exactly one same-destination replay with bounded header, query, or JSON Pointer mutations. Captured credentials remain inside ZAP and response bodies remain in history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { oneOf: [{ type: "integer" }, { type: "string" }] },
        header_mutations: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["set", "remove"] },
              name: { type: "string" },
              value: { type: "string" },
            },
            required: ["op", "name"],
          },
        },
        query_mutations: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["set", "remove"] },
              name: { type: "string" },
              value: { type: "string" },
            },
            required: ["op", "name"],
          },
        },
        json_body_mutations: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove"] },
              path: { type: "string" },
              value: {},
            },
            required: ["op", "path"],
          },
        },
        follow_redirects: { type: "boolean", default: false },
      },
      required: ["id"],
    },
  },
  {
    name: "zap_websocket_history",
    description: "Read a bounded page of WebSocket messages, optionally for one channel.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel_id: { oneOf: [{ type: "integer" }, { type: "string" }] },
        start: { type: "integer", minimum: 0, default: 0 },
        count: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
    },
  },
  {
    name: "zap_context_auth",
    description: "Call an installed context, authentication, session-management, users, or forced-user API operation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        component: {
          type: "string",
          enum: ["context", "authentication", "sessionManagement", "users", "forcedUser"],
        },
        type: { type: "string", enum: ["view", "action"] },
        operation: { type: "string" },
        parameters: { type: "object", additionalProperties: true },
      },
      required: ["component", "type", "operation"],
    },
  },
  {
    name: "zap_prompt_get",
    description:
      "Resolve one official ZAP MCP prompt, including baseline and full scan workflows, into its prompt messages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["name"],
    },
  },
]
