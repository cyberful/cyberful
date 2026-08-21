# GitHub CI/CD

`ci.yml` runs typechecking and local tests for pull requests and pushes to `main`. Canonical documentation validation belongs to the sibling `cy-website` repository.

No GitHub workflow builds or publishes a Cyberful container image. Native CLI builds embed the complete filtered runtime build context and its content fingerprint. The installed CLI builds and attests the matching `cyberful-os:runtime-<fingerprint>` image locally on first startup, and reuses it until the runtime context changes.

`release.yml` is manual. Run it from `main` with an explicit stable SemVer. It verifies the embedded runtime manifest and fingerprint in every native CLI build before packaging. Its dry run publishes nothing. A live run stages an immutable GitHub Release, publishes npm through OIDC, and only then makes the GitHub Release public.

The npm publish job uses trusted publishing. It requires `release.yml` to be registered as the GitHub Actions publisher for every public npm package; it does not use an `NPM_TOKEN` repository secret. See the [release policy](https://cyberful.ai/open-docs/development/release/) for the one-time first-release procedure.
