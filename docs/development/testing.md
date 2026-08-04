# Testing and CI

Run checks from the repository root. The root `package.json` intentionally
rejects a generic test command so package-specific isolation is preserved.

| Command                 | Coverage                                             |
| ----------------------- | ---------------------------------------------------- |
| `make typecheck`        | Code-principle checks and TypeScript type checking   |
| `make test-bun`         | Application, Pi runtime, provider, and browser tests |
| `make test-python`      | cyberful-os Python unit tests                        |
| `make runtime-build`    | Native unified cyberful-os image                     |
| `make test-runtime`     | Full image, ZAP, Ghidra, bridge, and lifecycle contract |
| `make test-cyberful-os` | Real image, catalog, MCP, and gateway contract       |
| `make test-network`     | Browser socket integration                           |
| `make test-zap`         | Docker ZAP, bridge, browser proxy, scan, and cleanup |
| `make test-ghidra`      | Real Ghidra import, analysis, MCP, and restart state |
| `make docs-build`       | Strict documentation build and link validation       |

Before publishing a change, scan the checkout for secrets. This is a safety net,
not permission to place a real credential in Git history even briefly.

`make test` runs the default Bun, Python, and live cyberful-os tiers.
`make runtime-build` followed by `make test-runtime` is the complete tooling
image gate; focused ZAP and Ghidra targets reuse that image without rebuilding
separate runtimes. `make test-all` adds the remaining network contracts. Pi provider-wire,
system-message, security-block, delegation, and fallback behavior is covered by
the isolated Bun tier without requiring a live model turn.

The network tier exercises the browser socket contract. It remains outside the
default Bun tier because restricted sandboxes may forbid binding a loopback
socket.

GitHub CI runs `make typecheck test-bun test-python` and the strict documentation
build for every pull request and push to `main`. A runtime-affecting pull request
stops at the protected `runtime-pr` environment until the repository owner
chooses **Review deployments** and approves that exact run. Approval creates
one ephemeral `linux/amd64` and one ephemeral `linux/arm64` EC2 runner; rejected
or unreviewed runs consume no EC2 capacity. A manual `runtime.yml` run outside
`main` has the same reviewed, non-publishing behavior. Pull requests and
non-main manual runs upload logs only. Main builds and pushes each native
platform with BuildKit SBOM and provenance, pulls and tests that exact published
digest, assembles one OCI index, and signs its digest through GitHub OIDC. No
QEMU is installed or used.

All runtime runs share the `runtime-native` FIFO concurrency queue, so AWS can
never run more than the dedicated amd64/arm64 pair for this repository. The
OCI index stores its source commit, and the next run compares from that
revision so a failed publication cannot make a later non-runtime commit copy a
stale image.
When no runtime boundary changed, the workflow verifies `edge` and its Cosign
signature before copying the same digest registry-side to the new `sha-*` tag.
Before moving `edge`, a build also checks that its commit is still the live head
of `main`, so an older queued run cannot regress the tag.

Each runtime runner receives the labels `self-hosted`, `linux`,
`cyberful-container`, and its architecture (`amd64` or `arm64`), plus at least
100 GB free, Docker BuildKit/buildx, Bun, npm, Python, a C compiler, and
passwordless `sudo` for the pinned browser's Linux packages. The workflow
installs the pinned Patchright Chromium and its host libraries before the live
proxy tests; system Chrome is exercised when the runner already provides it.
BuildKit exports an architecture-scoped cache to GitHub Actions and restores it
on later runs, so disposable instances still reuse safe Docker layers. The
publishable image remains a fresh, digest-addressed result; local BuildKit state
is pruned to an 80 GB bound and the encrypted root volume is deleted with the
instance.

## Ephemeral runner control plane

Deploy `infra/github-runners.yml` once in `eu-central-1`. Record its three
outputs as the `AWS_RUNNER_ROLE_ARN`, `AWS_RUNNER_AMD64_TEMPLATE_ID`, and
`AWS_RUNNER_ARM64_TEMPLATE_ID` variables in both GitHub environments:

- `runtime-pr` requires `ottaviofogliata` as its only reviewer and permits
  self-review, because GitHub does not allow a pull-request author to approve
  their own PR review.
- `runtime-main` has no required reviewer and permits deployments only from
  `main`; cleanup and trusted main publication use it automatically.

Install a repository-scoped GitHub App with repository Administration write
permission, used only to mint the one-hour runner registration token. Store its
numeric app ID as `CYBERFUL_RUNNER_APP_ID` and its private key as the
`CYBERFUL_RUNNER_APP_PRIVATE_KEY` environment secret in both environments.
Never store either the registration token or AWS credentials in repository
secrets. The private key is available only after the environment policy admits
the job; AWS credentials come from GitHub OIDC and expire with the job.

The provisioning job writes each one-time registration token to an encrypted
SSM parameter. The matching EC2 instance consumes and deletes it before running
any pull-request code. The instance has no inbound security-group rules,
requires IMDSv2 with a hop limit of one, terminates after its single ephemeral
job, and has a four-hour shutdown deadline. The trusted cleanup workflow on
`main` handles cancellation and an hourly stale-capacity sweep.
