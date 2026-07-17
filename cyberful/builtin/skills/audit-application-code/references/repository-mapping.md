# Repository and Architecture Mapping

## Contents

1. Build and runtime truth
2. Component inventory
3. Entry points
4. Trust and identity
5. Data and secrets
6. Build and deployment
7. Audit work products

## Build and runtime truth

Identify package managers, lockfiles, workspaces, build profiles, feature flags, code generation, conditional compilation, runtime versions, container stages, deployment overlays, and environment-dependent configuration. Determine which files are source of truth versus generated, vendored, example, migration, test, or dead compatibility code.

Record production entry commands and artifacts. A repository tree is not the deployed system.

## Component inventory

For each component record:

- responsibility and owner;
- language, framework, runtime, and version constraints;
- process or trust boundary;
- inbound protocols and callers;
- outbound services and credentials;
- persistence, cache, queue, and filesystem access;
- privilege, network position, and deployment identity;
- security controls implemented or assumed.

Include workers, scheduled tasks, migrations, administration tools, CLIs, webhooks, serverless handlers, plugins, importers, renderers, and build-time code.

## Entry points

Inventory routes, controllers, resolvers, RPC methods, message consumers, file watchers, deserializers, template renderers, command handlers, plugin hooks, signal handlers, cron jobs, CI events, mobile deep links, WebViews, browser messaging handlers, and LLM tool calls.

For each entry point capture parser, authentication context, authorization policy, schema, size and cost limits, side effects, error path, logging, and downstream calls.

## Trust and identity

Draw boundaries for:

- browser versus server;
- public edge versus internal services;
- user, tenant, administrator, support, and machine identities;
- issuer, audience, client, redirect, and federation parties;
- gateway claims versus service-local authorization;
- synchronous caller versus queued or scheduled work;
- trusted configuration versus user-controlled metadata;
- model instructions versus retrieved or user-controlled content.

Locate where identity is created, transformed, cached, serialized, delegated, impersonated, revoked, and audited.

## Data and secrets

Classify credentials, tokens, personal data, financial data, health data, source code, business records, cryptographic material, telemetry, and operational metadata. Trace every copy through databases, caches, queues, object storage, logs, exports, email, analytics, backups, browser/mobile storage, crash reports, and test fixtures.

Map secret origin, delivery, in-memory lifetime, subprocess inheritance, log exposure, rotation, revocation, and blast radius.

## Build and deployment

Inspect registry selection, dependency scripts, build network access, CI triggers, pull-request trust, reusable workflows, artifact stores, signing, provenance, deployment credentials, promotion rules, infrastructure as code, admission policy, runtime identity, secret mounting, and rollback.

## Audit work products

Maintain four linked indexes:

1. Component map.
2. Entry-point and trust-boundary map.
3. Security-control ownership map.
4. Candidate and evidence ledger.

Every finding must point into these indexes so reviewers can distinguish one local defect from a systemic control failure.
