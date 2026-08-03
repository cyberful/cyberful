# GitHub CI/CD

`ci.yml` runs typechecking, local tests, and the strict documentation build for
pull requests and pushes to `main`.

`runtime.yml` owns `ghcr.io/cyberful/cyberful-os`. Every pull request builds and
tests native `linux/amd64` and `linux/arm64` images on the two dedicated
self-hosted runner classes without publishing. A manual run outside `main` is
the same non-publishing native check. Runs on `main` are queued and processed in
order. Runtime changes push one tested native digest per architecture with
BuildKit SBOM/provenance, then a bounded index job creates
`sha-<40-character-commit>`, verifies exactly the two executable platforms,
and signs the immutable digest with Cosign and GitHub OIDC. When that commit is
still the head of `main`, the same operation also moves `edge` to the identical
index. Commits that do not affect the runtime copy the verified, signed `edge`
index registry-side to their immutable `sha-*` tag without rebuilding.

The OCI index records the source revision. Change detection compares the new
commit with that revision, rather than only its immediate predecessor, so a
later queued run rebuilds after an earlier failed runtime publication. A rerun
never overwrites an existing `sha-*` tag; it verifies it and can finish an
interrupted keyless signature. Checking the live `main` head before moving
`edge` prevents an older run from regressing the moving tag.

The first successful publication creates the GHCR package. A repository owner
must then make it public once in package settings; the image source label links
it back to this repository. See the release guide for that bootstrap step.

`release.yml` is manual. Run it from `main` with an explicit stable SemVer. It
resolves and verifies the signed `sha-${GITHUB_SHA}` runtime index, embeds that
digest in every native CLI build, and checks the binary bytes before packaging.
Its dry run publishes nothing. A live run promotes the same runtime digest to
`vX.Y.Z`, `X.Y`, and `latest` without rebuilding, stages an immutable GitHub
Release, publishes npm through OIDC, and only then makes the GitHub Release
public. An existing immutable version tag may only point to that exact digest.

The npm publish job uses trusted publishing. It requires `release.yml` to be
registered as the GitHub Actions publisher for every public npm package; it
does not use an `NPM_TOKEN` repository secret. See
[`docs/development/release.md`](../../docs/development/release.md) for the
one-time first-release procedure.
