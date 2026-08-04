# GitHub CI/CD

`ci.yml` runs typechecking, local tests, and the strict documentation build for
pull requests and pushes to `main`.

`runtime.yml` owns `ghcr.io/cyberful/cyberful-os`. Runtime-affecting pull
requests reach a protected `runtime-pr` environment after the cheap selection
job; only an explicit deployment review by the repository owner releases AWS
OIDC and the GitHub runner credential. The approved run creates exactly one
ephemeral `linux/amd64` and one ephemeral `linux/arm64` EC2 runner without
publishing. A manual run outside `main` uses the same reviewed path. Runs on
`main` use the unreviewed, main-only `runtime-main` environment and are queued
with PR runtime validation in one global FIFO, bounding live capacity to two
instances. Each native job installs the pinned Patchright Chromium and its
Linux libraries before exercising browser-through-ZAP; system Chrome is an
optional additional channel when the runner provides it. Architecture-scoped
GitHub Actions caches preserve final-image BuildKit layers across disposable
instances without retaining quota-heavy intermediate stages. Runtime changes
push
one tested native digest per architecture with BuildKit SBOM/provenance, then a
bounded index job creates
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

`runtime-runner-cleanup.yml` is evaluated from `main` after every completed
runtime run. It terminates instances carrying the repository's managed tags and
deletes unused one-time registration parameters; an hourly sweep removes only
capacity older than four hours. Each runner also shuts itself down after its
single ephemeral job, and EC2 translates that shutdown into termination. The
AWS boundary is reproducible from `infra/github-runners.yml`: launch templates
have no inbound rules, require IMDSv2, use encrypted disposable volumes, and
grant the instance only permission to consume and delete its one-time SSM
parameter.

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
