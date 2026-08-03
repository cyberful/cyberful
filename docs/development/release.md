# Release policy

## Documentation publication

The **Documentation** workflow builds the complete MkDocs site with strict link
and navigation validation, uploads only the generated `site/` artifact, and
publishes it to the `github-pages` environment at
[cyberful.io](https://cyberful.io/). It runs when documentation, theme,
dependency, or publication-workflow files change on `main`, and it can also be
started manually.

GitHub Pages must use **GitHub Actions** as its build source. The custom domain
remains `cyberful.io`; Cloudflare provides authoritative DNS only, while GitHub
Pages terminates and enforces HTTPS. The site loads no remote fonts and emits no
analytics or telemetry.

Cyberful publishes the unscoped `cyberful` launcher plus native packages under
the `@cyberful-org` npm organization for macOS arm64/x64, Linux x64, and
Windows x64. x64 packages contain normal and baseline binaries; the launcher
selects the compatible binary at install time. Users install only `cyberful`.

Stable releases are explicit. From the GitHub Actions **Release** workflow,
select `main`, enter a stable SemVer without a `v` prefix, and choose whether to
run dry. The first public version is `0.1.0`; every later version must be greater
than the latest stable tag.

Every commit on `main` first receives
`ghcr.io/cyberful/cyberful-os:sha-<40-character-commit>`. Runtime changes build
native amd64/arm64 manifests, publish them by digest with BuildKit attestations,
and test those exact registry digests before indexing them; other commits copy
the verified current `edge` index registry-side. Release refuses a commit without both native
manifests, BuildKit provenance and SBOM, and the keyless Cosign signature from
`runtime.yml` on `main`.

After the first `main` publication, set the `cyberful-os` container package to
**Public** in the GitHub package settings and confirm it is connected to this
repository. The OCI `org.opencontainers.image.source` label establishes the
repository link; public visibility is a one-time package-owner setting and must
be in place before announcing the first release.

A dry run resolves the runtime by digest, passes that immutable reference as
`CYBERFUL_RUNTIME_IMAGE` to all four platform builds, verifies each binary
contains it, assembles the launcher and native archives, generates an SPDX
release SBOM and SHA-256 checksums, and retains the result as a workflow
artifact. It does not create or move release tags and publishes nothing.

A live run performs the same work, then:

1. promotes the already signed runtime digest, without rebuilding it, to
   `v<version>`, `<major>.<minor>`, and `latest`;
2. refuses to overwrite an existing immutable runtime version tag with a
   different digest;
3. creates or verifies the annotated source `v<version>` tag at the selected
   `main` commit;
4. creates a draft GitHub Release and uploads its immutable assets;
5. publishes the four platform packages, then `cyberful`;
6. makes the GitHub Release public only after every npm package succeeds.

Release archives include the AGPL license, third-party notices, and the font
and wordlist license texts. A partial release is resumed from its original tag
and commit. Already-published npm artifacts are accepted only when their remote
integrity exactly matches the release artifact; a version can never be rebuilt
with different bytes.

## One-time npm bootstrap

npm trusted publishing can be configured only after a package exists. The
first release therefore has one manual publication step:

1. Authenticate to npm as the `cyberful` account, enable account-level
   two-factor authentication, use Node.js 22.14 or newer with npm 11.5.1 or
   newer, and confirm that the account owns the free public `cyberful-org`
   organization:

   ```sh
   node --version
   npm --version
   npm whoami
   npm org ls cyberful-org
   ```

   The first command must print `cyberful`; the second must list `cyberful` as
   an owner. The unscoped `cyberful` package and all four organization packages
   must still be unpublished before this bootstrap.
2. Merge the active `ci.yml`, `runtime.yml`, and `release.yml` workflows to
   `main`; wait for CI and the first signed `sha-*` runtime index.
3. Run **Release** from `main` with version `0.1.0` and `dry_run: false`. The
   publish step is expected to stop with `ENEEDAUTH`, after the tag, draft
   GitHub Release, and exact release assets have been created.
4. Download the draft release assets, authenticate locally with `npm login`,
   and publish the exact five tarballs with the repository helper:

   ```sh
   gh auth login
   gh release download v0.1.0 --repo cyberful/cyberful --dir /tmp/cyberful-v0.1.0
   npm login
   bun scripts/publish-npm.ts --directory /tmp/cyberful-v0.1.0 --version 0.1.0
   ```

   npm may request a current one-time password while the helper publishes each
   platform package and finally the launcher. Do not repack or rename the
   downloaded tarballs.

5. In the settings for each package, add the same npm trusted publisher:

   | Package                                  | Publisher      | Organization | Repository | Workflow      | Allowed action |
   | ---------------------------------------- | -------------- | ------------ | ---------- | ------------- | -------------- |
   | `@cyberful-org/cyberful-darwin-arm64`    | GitHub Actions | `cyberful`   | `cyberful` | `release.yml` | `npm publish`  |
   | `@cyberful-org/cyberful-darwin-x64`      | GitHub Actions | `cyberful`   | `cyberful` | `release.yml` | `npm publish`  |
   | `@cyberful-org/cyberful-linux-x64`       | GitHub Actions | `cyberful`   | `cyberful` | `release.yml` | `npm publish`  |
   | `@cyberful-org/cyberful-windows-x64`     | GitHub Actions | `cyberful`   | `cyberful` | `release.yml` | `npm publish`  |
   | `cyberful`                               | GitHub Actions | `cyberful`   | `cyberful` | `release.yml` | `npm publish`  |

   Leave the environment field empty. The workflow runs on GitHub-hosted
   runners with `id-token: write`; no `NPM_TOKEN` repository secret is used.
   With a current authenticated npm CLI, the same five registrations can be
   created without the web form:

   ```sh
   npm trust github @cyberful-org/cyberful-darwin-arm64 --repo cyberful/cyberful --file release.yml --allow-publish
   npm trust github @cyberful-org/cyberful-darwin-x64 --repo cyberful/cyberful --file release.yml --allow-publish
   npm trust github @cyberful-org/cyberful-linux-x64 --repo cyberful/cyberful --file release.yml --allow-publish
   npm trust github @cyberful-org/cyberful-windows-x64 --repo cyberful/cyberful --file release.yml --allow-publish
   npm trust github cyberful --repo cyberful/cyberful --file release.yml --allow-publish
   ```

   Confirm each result with `npm trust list <package>`. npm does not validate
   the repository/workflow tuple when it is saved, so check the spelling
   exactly before the CI retry.

6. Re-run the failed **Publish npm packages** job. The helper verifies and skips
   the five matching packages; its dependent **Publish the GitHub Release** job
   then makes the draft release public.
7. For every package, set publishing access to require two-factor
   authentication and disallow tokens. Future releases authenticate through
   short-lived OIDC credentials and npm adds package provenance automatically.

If the unscoped `cyberful` name or any required `@cyberful-org` package cannot
be published by the authenticated owner, stop before announcing the release.
Do not substitute another public launcher name: it would break the documented
`npm install --global cyberful` contract.

## GitHub release prerequisites

- Keep `main` as the default protected branch and require both
  **Typecheck, test, and docs** and **Unified runtime required** before merging.
  Require `main` to advance by one
  first-parent commit per push (squash or a single merge commit; no rebase
  merges or direct multi-commit pushes), because GitHub emits one workflow SHA
  per push. The runtime workflow queues up to 100 `main` runs and processes
  registry mutations one at a time.
- Register exactly two self-hosted runner classes with the labels documented in
  the testing guide. Do not install or register QEMU/binfmt emulators on them.
  Keep the runner agent current and provision these as ephemeral, clean hosts:
  pull requests execute repository code and use the Docker socket, so a
  persistent PR runner must never later become a trusted `main` publisher.
- Allow GitHub Actions to write repository packages. The runtime assembly job
  and interrupted-signature recovery receive `packages: write` plus
  `id-token: write` for Cosign; runtime platform jobs and tag-copy jobs receive
  `packages: write` without OIDC.
- Keep the GHCR package connected to `cyberful/cyberful` and public before the
  first announced release. No Cosign key or npm token is stored in repository
  secrets: both signatures and npm trusted publishing use GitHub OIDC.
- Enable immutable GitHub Releases in repository or organization settings so
  publishing locks the source tag and uploaded release assets. That setting
  does not cover GHCR: the workflows enforce `sha-*` and `vX.Y.Z` immutability
  by refusing a different existing digest, so restrict package write access to
  this repository's Actions workflow and maintainers.
- Configure the five npm trusted publishers exactly as listed above. The npm
  job is the only release job with `id-token: write`; GHCR promotion and GitHub
  Release publication run in separate, narrower-permission jobs.
