# API Inventory and Contract

## Inventory sources

- deployed gateway and reverse-proxy configuration;
- server route, controller, RPC, and message-consumer registration;
- OpenAPI, AsyncAPI, protobuf, WSDL, schemas, SDKs, and generated clients;
- browser, mobile, desktop, partner, CLI, and service traffic;
- DNS, service discovery, certificates, manifests, ingress, and load balancers;
- logs and metrics metadata that do not expose sensitive payloads;
- legacy versions, beta routes, debug endpoints, and alternate environments.

## Contract dimensions

Record accepted methods, path variables, query and header parameters, body media types, encodings, schemas, defaults, nullable fields, unknown-field behavior, maximum sizes, errors, success and async semantics, idempotency, authentication scheme, scope, authorization, rate policy, and deprecation.

## Drift analysis

Compare specification to deployed behavior and deployed behavior to every client. Flag hidden operations, deprecated versions still reachable, inconsistent security schemes, stale SDK assumptions, alternate content types, shadow APIs, and internal endpoints exposed by routing changes.

## Version and environment isolation

Verify that old versions do not retain broader fields, weaker authentication, missing authorization, unsafe parsers, or forgotten debug behavior. Check data and identity separation between production, staging, preview, regional, partner, and sandbox environments.

## Coverage ledger

Use one row per operation and representative security dimension. Avoid combinatorial testing only after proving shared schema, middleware, policy, and data-access enforcement.
