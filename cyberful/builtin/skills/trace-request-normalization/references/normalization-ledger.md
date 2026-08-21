# HTTP Normalization Ledger

## Per-hop fields

For every adjacent component pair record input protocol, output protocol, connection ownership, authority derivation, host validation, path bytes, decoded path, query representation, duplicate-field policy, body framing, trailer policy, hop-by-hop removal, forwarding metadata, and the evidence source.

## Differential dimensions

- Authority: request target, Host, `:authority`, absolute-form URLs, and trusted forwarding fields.
- Path: slash merging, dot segments, encoded delimiters, semicolon parameters, backslashes, Unicode, and decode count.
- Query: duplicate names, empty values, separators, array syntax, plus handling, and decoding order.
- Fields: case, whitespace, folding, commas, duplicate lines, underscores, and invalid-name rejection.
- Body: content length, transfer coding, protocol translation, early responses, trailers, and connection reuse.

## Evidence threshold

Require two observed component interpretations or one interpretation plus a deterministic downstream security effect. Preserve a matched canonical control. Treat gateway errors, latency, and inconsistent status as triage signals until component-local evidence identifies the disagreement.

