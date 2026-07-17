# Metasploit Module Field Manual

## Module truth is in code and notes

Module rank measures reliability under expected conditions, not applicability or safety. Inspect:

- check implementation and what response actually maps to each CheckCode;
- target auto-selection predicates and default target;
- payload compatibility declarations;
- bad characters, space, prepend/append behavior, encoder interaction;
- whether fail_with distinguishes a negative target from a malformed run;
- cleanup registration and whether cleanup also runs after partial failure;
- retry, timeout, SSL, VHOST, Proxies, HttpClientTimeout, TARGETURI, and URIPATH handling;
- service mixins that normalize paths, cookies, redirects, or authentication.

Rare failure pattern: the module's version regex recognizes the marketing version but the vulnerable component is independently patched. Reverse the decision: identify the exact vulnerable function or response behavior and look for it directly.

## Target and transport differentials

- Test IP plus VHOST; many HTTP modules otherwise reach a default virtual host.
- Preserve SNI independently of Host when a proxy, load balancer, or CDN is present.
- Compare direct and proxied paths; a module may fail because the intermediary rewrites chunking, redirects, cookies, or connection reuse.
- For RPC and binary protocols, confirm negotiation dialect and feature bits rather than port alone.
- For STARTTLS services, distinguish implicit TLS, explicit upgrade, and plaintext paths.
- Treat IPv4/IPv6, hostname/IP, and internal/external routes as separate observations.

## Datastore traps

- RHOSTS accepts ranges and files; prove the resolved set before a run.
- RPORT defaults may be protocol-correct but deployment-wrong.
- TARGETURI normalization differs between modules; verify leading/trailing slash behavior.
- HttpUsername/HttpPassword, USERNAME/PASSWORD, and protocol-specific credential keys are not interchangeable.
- Global Proxies, LHOST, LPORT, SSL, VHOST, and workspace values can silently contaminate later modules.
- A module may use both service credentials and session context; identify which authority each action inherits.

## Handler and session interpretation

A reverse payload exercises two paths: exploit delivery and callback. Separate failures:

1. delivery never reached target;
2. target rejected or crashed before execution;
3. payload executed but callback route failed;
4. handler bound the wrong interface/address family;
5. staging connection succeeded but stage transfer failed;
6. session opened and died due to process lifetime, AV, architecture, or channel assumptions.

Use a target-side marker or protocol response when callback uncertainty would dominate. If a session is necessary, record route table, handler bind, advertised callback address, job state, session type, peer, and lifetime.

## Module-chain reasoning

High-yield chains often pair:

- scanner result -> version/config auxiliary -> exploit;
- credential validation -> authenticated configuration query -> exploit target selection;
- file-read primitive -> configuration/secret discovery -> authenticated module;
- SSRF/proxy path -> internal service module;
- session -> local architecture/privilege inventory -> narrowly selected local module;
- module output -> manual replay outside Metasploit for independent confirmation.

Do not let a session erase the original cause. Preserve the initial unauthenticated/authenticated boundary, the authority gained, and the minimum action that connected them.

## False-negative checklist

- wrong target index or auto-target fingerprint;
- module fixed after the packaged Metasploit revision;
- patched backport with unchanged banner;
- missing required feature/configuration;
- alternate URI, virtual host, realm, tenant, or protocol dialect;
- check method less capable than exploit method;
- WAF or proxy blocks the signature but not the underlying weakness;
- stale database/search index;
- payload and exploit both failed, making the vulnerability untested;
- target-side success occurred but module matcher rejected the response;
- race window or one-shot state was not reset between attempts.

## Evidence threshold

Strong confirmation links:

module input -> exact target path -> target-side observable -> independent replay or artifact -> cleanup

Console banners, generic timeout, target crash without causality, and a module's optimistic status string are supporting evidence only.
