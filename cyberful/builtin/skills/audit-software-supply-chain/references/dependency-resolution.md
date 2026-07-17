# Dependency Resolution and Package Trust

## Resolution Questions

For each package manager:

- Which registry wins for an unscoped or scoped name?
- Can namespace ownership differ between public and private registries?
- Are versions ranges, tags, branches, or mutable URLs accepted?
- Does the lockfile cover transitive packages, source, integrity, and platform variants?
- Can install, prepare, post-install, plugin, or compiler hooks execute?
- Are optional, peer, dev, build, and platform-specific dependencies present in production builds?
- Can environment variables, user config, or working-directory files alter resolution?

Test resolution in an isolated environment with the same configuration and without publishing or claiming names.

## Confusion and Substitution Families

Consider public/private name collision, namespace takeover, typosquatting, VCS ref movement, mutable release assets, mirror poisoning, fallback-to-public behavior, alternate package formats, package-manager cache substitution, and dependency proxy misconfiguration.

Distinguish a plausible name collision from a confirmed selectable package path. Evidence should show the resolver and precedence that would select attacker-controlled bytes.

## Component Reachability

Prioritize:

- build-time execution;
- runtime-loaded plugins and adapters;
- parsers on untrusted data;
- authentication and cryptographic components;
- network-exposed code;
- privileged administrative paths.

A vulnerable version is not necessarily reachable; an apparently unused package may still execute through install scripts, reflection, plugin discovery, or framework auto-registration.

## Rare Hints

- Lockfiles can be ignored for workspace, container, release, or platform-specific builds.
- Package aliases and overrides can hide the selected upstream name.
- Generated language clients introduce second ecosystems and generators.
- Compiler plugins, linters, formatters, test reporters, and documentation tools execute in privileged CI despite not shipping.
- A package mirror can validate metadata while serving bytes from a mutable upstream URL.
- Reproducible version labels do not imply reproducible source, toolchain, timezone, locale, or generated inputs.
