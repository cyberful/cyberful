# Release policy

## Documentation publication

The **Documentation** workflow builds the complete MkDocs site with strict link and navigation validation, uploads only the generated `site/` artifact, and publishes it to the `github-pages` environment at [cyberful.io](https://cyberful.io/). GitHub Pages terminates HTTPS; the site loads no remote fonts and emits no analytics or telemetry.

## Native packages and the local runtime

Cyberful publishes the unscoped `cyberful` launcher plus native packages under the `@cyberful-org` npm organization for macOS arm64/x64, Linux x64, and Windows x64. x64 packages contain normal and baseline binaries; users install only `cyberful`.

Stable releases are explicit. From the GitHub Actions **Release** workflow, select `main`, enter a stable SemVer without a `v` prefix, and choose whether to run dry. Every later version must be greater than the latest stable tag.

No release or CI workflow builds or publishes cyberful-os. Every native executable embeds the complete filtered `mcps/` Docker build context and a SHA-256 fingerprint derived only from its paths and contents. A CLI-only release whose context is unchanged therefore reuses the existing attested local image. A runtime change receives a new `cyberful-os:runtime-<fingerprint>` tag and is built on the user's Docker host at first startup.

The build prints ordinary BuildKit output and appends it to a private local log. Cyberful requires at least 100 GB free before starting it, serializes concurrent builders, attests the completed candidate before moving the canonical tag, and keeps only the current and previous managed image. `CYBERFUL_OS_IMAGE` remains an explicit operator override and is never deleted by managed-image pruning.

Native releases also embed the exact first-party CVE Dictionary publication descriptor from `cyberful/src/cve-dictionary/publication.ts`. When publishing a new dictionary, update its version, generation timestamp, immutable manifest URL, manifest SHA-256, Sigstore trusted-root SHA-256, compressed size, and database size before the next Cyberful release, then reconcile the technical README, runtime page, requirements, and tool catalog. Local startup never discovers a mutable “latest” release or fetches a mutable TUF root; it advances managed state only from these reviewed bytes.

A dry run verifies source, tests, documentation, native binaries, the embedded runtime manifest, npm archives, SPDX metadata, and checksums. It publishes nothing. A live run then creates or verifies the annotated source tag and draft GitHub Release, uploads immutable assets, publishes the platform packages followed by the launcher through npm OIDC, and makes the GitHub Release public only after npm succeeds.

Release archives include the AGPL license, third-party notices, and bundled asset licenses. A partial release resumes from its original tag and commit. Already-published npm artifacts are accepted only when their remote integrity exactly matches the release artifact; a version is never rebuilt with different bytes.

## One-time npm bootstrap

npm trusted publishing can be configured only after a package exists. For the first release, run the live workflow once to create the tag, draft, and exact assets; if npm stops with `ENEEDAUTH`, download those assets and publish the exact five tarballs with `bun scripts/publish-npm.ts --directory <download> --version <version>`. Do not repack or rename them.

Configure the same GitHub Actions trusted publisher for `@cyberful-org/cyberful-darwin-arm64`, `@cyberful-org/cyberful-darwin-x64`, `@cyberful-org/cyberful-linux-x64`, `@cyberful-org/cyberful-windows-x64`, and `cyberful`: organization `cyberful`, repository `cyberful`, workflow `release.yml`, allowed action `npm publish`, and no environment. The workflow uses `id-token: write`; no `NPM_TOKEN` is stored.

After registration, rerun the failed npm job. Require two-factor authentication for package publishing and disallow long-lived tokens. If any required package name cannot be published by the authenticated owner, stop before announcing the release.

## GitHub release prerequisites

- Keep `main` as the default protected branch and require **Typecheck, test, and docs** before merging.
- Enable immutable GitHub Releases so publication locks the source tag and uploaded assets.
- Configure the five npm trusted publishers exactly as described above.
- Do not configure GHCR, Cosign, AWS runner roles, runtime environments, or container-package permissions for Cyberful releases; they are no longer part of the release path.
