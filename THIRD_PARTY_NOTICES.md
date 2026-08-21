# Third-party notices

Cyberful is licensed under `AGPL-3.0-only`. The components below retain their own licenses and copyright notices. Dependency metadata for packaged releases is also published in the SPDX SBOM attached to each GitHub Release.

## OpenCode

Portions of Cyberful were derived from [`anomalyco/opencode`](https://github.com/anomalyco/opencode) branch `dev` at commit `7703786498e2d3609f649168e54919c344fe10ee` (25 May 2026). Those portions retain the following MIT notice:

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Bundled report fonts

Generated PDF reports embed:

- EB Garamond Regular and Bold, copyright the EB Garamond Project Authors and Deborah Khodanovich, under the SIL Open Font License 1.1.
- Ubuntu Mono Regular, copyright Canonical Ltd., under the Ubuntu Font Licence 1.0.

Exact upstream revisions and SHA-256 digests are recorded in `cyberful/src/tool/assets/fonts/README.md`. Release archives preserve the full font terms as `licenses/EB_GARAMOND_OFL.txt` and `licenses/UBUNTU_FONT_LICENCE.txt`.

## SecLists wordlists

The offline credential and content-discovery wordlists under `mcps/cyberful-os/wordlists/` come from SecLists release `2026.1` and are distributed under the MIT License, copyright Daniel Miessler. Exact paths and digests are recorded beside the lists. Release archives preserve the notice as `licenses/SECLISTS_LICENSE.txt`.

## OWASP ZAP

The isolated ZAP runtime is based on OWASP ZAP and its official container artifacts. Its Apache License 2.0 attribution is recorded in `mcps/zap/THIRD_PARTY_NOTICES.md`. ZAP is distributed inside the unified cyberful-os OCI image; it is not embedded in the Cyberful executable.

## agent-browser

Cyberful embeds the [Cyberful agent-browser fork](https://github.com/cyberful/agent-browser) `0.34.0-cyberful.3`, derived from Vercel's agent-browser and distributed under the Apache License 2.0. Release browser payloads retain the exact `LICENSE` file alongside package metadata, native executable, and versioned skill data.

## MITRE ATT&CK

Each Cyberful release embeds a build-resolved snapshot of the official MITRE ATT&CK Enterprise, Mobile, and ICS STIX 2.1 data. The release manifest records the exact versions, source URLs, sizes, and SHA-256 digests; the platform-neutral ATT&CK archive retains the original source bundles, derived SQLite database, SPDX metadata, checksum manifest, and complete upstream license.

“© 2026 The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation.” ATT&CK® is a registered trademark of The MITRE Corporation. MITRE grants a non-exclusive, royalty-free license for research, development, and commercial use provided its copyright designation and license are reproduced. The complete build-acquired terms are distributed as `LICENSE.txt` inside every ATT&CK snapshot archive and materialized runtime snapshot.
