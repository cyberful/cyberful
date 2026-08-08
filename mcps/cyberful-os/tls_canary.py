#!/usr/bin/env python3
# ── Private TLS Client Canary ───────────────────────────────────────
# Serves bounded Git, pip, Bundler, and ordinary HTTPS fixtures only
#   on the engagement Docker network during host-owned preflight.
# → cyberful/src/subsystem/engagement-runtime.ts — owns lifecycle and verification.
# ────────────────────────────────────────────────────────────────────
"""Serve private HTTPS fixtures for the engagement TLS trust preflight."""

from __future__ import annotations

import argparse
import http.server
import os
import pathlib
import ssl
import subprocess
import zipfile


def run(*command: str, cwd: pathlib.Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True, stdin=subprocess.DEVNULL)


def prepare_git(root: pathlib.Path) -> None:
    repository = root / "git" / "canary.git"
    repository.parent.mkdir(parents=True)
    run("git", "init", "--bare", str(repository))
    run("git", "--git-dir", str(repository), "update-server-info")


def prepare_wheel(root: pathlib.Path) -> None:
    package = "cyberful_canary"
    version = "0.0.0"
    filename = f"{package}-{version}-py3-none-any.whl"
    destination = root / "packages" / filename
    destination.parent.mkdir(parents=True)
    metadata = f"{package}-{version}.dist-info"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as wheel:
        wheel.writestr(f"{package}.py", "VALUE = 'tls-canary'\n")
        wheel.writestr(
            f"{metadata}/METADATA",
            f"Metadata-Version: 2.1\nName: cyberful-canary\nVersion: {version}\n",
        )
        wheel.writestr(
            f"{metadata}/WHEEL",
            "Wheel-Version: 1.0\nGenerator: cyberful\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        )
        wheel.writestr(f"{metadata}/RECORD", "")
    simple = root / "simple" / "cyberful-canary"
    simple.mkdir(parents=True)
    (simple / "index.html").write_text(
        f'<a href="../../packages/{filename}">{filename}</a>\n',
        encoding="utf-8",
    )
    (root / "simple" / "index.html").write_text(
        '<a href="cyberful-canary/">cyberful-canary</a>\n',
        encoding="utf-8",
    )


def prepare_gem(root: pathlib.Path) -> None:
    repository = root / "gems"
    source = repository / "source"
    (source / "lib").mkdir(parents=True)
    (source / "lib" / "cyberful_canary.rb").write_text(
        "module CyberfulCanary; VALUE = 'tls-canary'; end\n",
        encoding="utf-8",
    )
    builder = """
require "rubygems/package"
root = ARGV.fetch(0)
Dir.chdir(root) do
  spec = Gem::Specification.new do |item|
    item.name = "cyberful-canary"
    item.version = "0.0.0"
    item.summary = "Cyberful TLS canary"
    item.authors = ["Cyberful"]
    item.files = ["lib/cyberful_canary.rb"]
    item.require_paths = ["lib"]
  end
  Gem::Package.build(spec)
end
"""
    run("ruby", "-e", builder, str(source))
    (repository / "gems").mkdir()
    built = source / "cyberful-canary-0.0.0.gem"
    built.replace(repository / "gems" / built.name)
    run("gem", "generate_index", "--directory", str(repository))


def certificate(root: pathlib.Path, hostname: str) -> tuple[pathlib.Path, pathlib.Path]:
    certificate_path = root / "canary.pem"
    key_path = root / "canary-key.pem"
    run(
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        f"/CN={hostname}",
        "-addext",
        f"subjectAltName=DNS:{hostname}",
        "-keyout",
        str(key_path),
        "-out",
        str(certificate_path),
    )
    return certificate_path, key_path


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_arguments: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hostname", required=True)
    parser.add_argument("--port", type=int, default=8443)
    arguments = parser.parse_args()
    root = pathlib.Path("/tmp/cyberful-tls-canary")
    root.mkdir(mode=0o700)
    prepare_git(root)
    prepare_wheel(root)
    prepare_gem(root)
    (root / "health").write_text("cyberful tls canary\n", encoding="utf-8")
    certificate_path, key_path = certificate(root, arguments.hostname)
    server = http.server.ThreadingHTTPServer(
        ("0.0.0.0", arguments.port),
        lambda *handler_arguments, **handler_options: Handler(
            *handler_arguments,
            directory=os.fspath(root),
            **handler_options,
        ),
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate_path, key_path)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    pathlib.Path("/tmp/cyberful-tls-canary.ready").write_text("ready\n", encoding="utf-8")
    server.serve_forever()


if __name__ == "__main__":
    main()
