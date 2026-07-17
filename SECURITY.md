# Security Policy

Cyberful handles source code, target traffic, credentials supplied to authorized
engagements, and security findings. Please report suspected vulnerabilities
privately so maintainers can investigate before public disclosure.

## Supported versions

The latest stable release is supported with security fixes. Development builds
from `main` receive best-effort fixes but are not a supported release channel.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting form:

<https://github.com/cyberful/cyberful/security/advisories/new>

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. Remove credentials, engagement data, and unrelated
personal information from the report. Do not open a public issue for an
unpatched vulnerability.

Maintainers will acknowledge a report as soon as practical, coordinate
validation and remediation, and credit reporters who want attribution. Public
disclosure timing will be coordinated after a fix or mitigation is available.

## Research boundary

Good-faith research against systems you own or are explicitly authorized to
test is welcome. Do not access third-party data, degrade services, persist after
authorization ends, or disclose sensitive data. This policy does not grant
authorization to test infrastructure outside the repository and its published
release artifacts.
