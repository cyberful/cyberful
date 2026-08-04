# Install Cyberful

Choose the standard npm installation unless you are developing Cyberful or need
to build its binaries yourself. If the computer does not yet have Docker,
Node.js, npm, or a configured provider, use the complete OS-specific
[fresh-host walkthrough](README.md) instead of starting on this page.

## Install the release

Install Cyberful and verify the command:

```sh
npm i -g cyberful
cyberful --version
```

The unscoped `cyberful` package installs the command and selects the matching
native package from the `@cyberful-org` npm organization. This path does not
require Bun. Published packages cover macOS on Apple silicon and Intel, Linux
on `x86_64` with glibc, and 64-bit x86 Windows.

Cyberful creates a secret-free `settings.yaml` with OpenAI Codex as the default
Pi provider. From the directory that will contain the engagement, authenticate
that route through Cyberful:

```sh
cyberful auth login
cyberful auth status
```

The subscription credentials remain in Cyberful's owner-only credential store
and never enter `settings.yaml`, prompts, transcripts, or reports. Use
`cyberful auth logout` to remove the configured provider credential.

## Build from source

From the repository root, install the workspace dependencies and run the local
Pi, prompt, provider, and gateway contract tests:

```sh
make deps
make test-bun
```

Build standalone binaries for every supported platform:

```sh
make build
```

To build the current platform and install `cyberful` for the current user:

```sh
make install
cyberful --version
```

`make install` places the command under `~/.cyberful/bin` and adds that
directory to the shell's `PATH`. Open a new shell if the command is not
immediately available. Because `make install` builds the current platform, you
can skip `make build` when you do not need the all-platform artifacts.

To launch the source checkout without installing it:

```sh
make run
```

Continue with [your first authorized penetration test](README.md).
