# URL, DNS, and Redirect Validation

## Parser Differential Checklist

Compare the validation parser with the connection library for:

- userinfo and multiple at-signs;
- bracketed IPv6, IPv4-mapped IPv6, zone identifiers, and noncanonical IP forms;
- Unicode hostnames, IDNA conversion, trailing dots, mixed case, and empty labels;
- percent encoding, backslashes, control characters, fragments, and encoded delimiters;
- scheme-relative and relative references;
- ambiguous ports and default ports;
- nested or embedded URLs;
- alternate schemes accepted by the client or downstream proxy.

Never build an allowlist with substring, suffix, or regex checks alone. Parse once with a defined URL model and compare canonical components.

## DNS and Connection Binding

Resolve all answers and reject any disallowed address, including private, loopback, link-local, multicast, unspecified, reserved, and metadata-specific ranges for IPv4 and IPv6. Account for CNAME chains, split-horizon responses, resolver search domains, and multiple A or AAAA answers.

Prevent time-of-check/time-of-use rebinding by binding the validated resolution to the connection or enforcing policy at a controlled egress proxy. Revalidate retries and redirects.

## Redirects

Apply the full policy to every hop. Limit hops, detect cycles, prevent relevant transport downgrade, strip credentials on origin changes, and reject prohibited schemes or networks.

Record method and body rewriting across redirect status codes; a nominal read fetch can become an internal write depending on client behavior.

## High-Yield Differential Hints

- Validation and fetch may run in different services, languages, or queues with different URL parsers.
- A hostname can be accepted while its trailing-dot or IDNA form bypasses a suffix comparison.
- Proxy environment variables can reroute an apparently direct request and change what `NO_PROXY` means.
- An initial allowlisted URL may return a refresh instruction, HTML subresource, XML entity, CSS URL, or document reference followed by a different component.
- DNS pinning at the application may not constrain a headless browser, renderer, or antivirus worker that refetches the object.
