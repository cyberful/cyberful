# Install Cyberful

Choose the standard npm installation unless you are developing Cyberful or need
to build its binaries yourself.

## Install the release

Install the Codex version validated by Cyberful, then authenticate it:

```sh
npm install --global @openai/codex@0.144.5
codex login
```

Install Cyberful and verify both commands:

```sh
npm install --global @cyberful/cli
codex --version
cyberful --version
```

The `@cyberful/cli` package installs a native Cyberful binary. This path does
not require Bun.

## Build from source

From the repository root, install the workspace dependencies and verify that
the installed Codex CLI satisfies Cyberful's app-server and MCP contract:

```sh
make deps
make test-codex
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
