# Files, Archives, and Paths

## Upload and Publication

Review:

- server-generated object identifiers instead of user-controlled filesystem names;
- extension, MIME, signature, and parser-based validation as distinct signals;
- Unicode, separators, reserved names, trailing characters, normalization, and case;
- storage outside executable or directly served roots;
- forced download and safe content types for user-controlled objects;
- tenant authorization on originals and derivatives;
- overwrite, deduplication, versioning, and race behavior;
- partial, rejected, quarantined, and temporary object cleanup.

Polyglot risk depends on which consumers parse the same bytes. Enumerate consumers before designing a probe.

## Traversal and Inclusion

Resolve against an explicit root with a canonical path API, then verify containment. Consider absolute paths, drive and UNC forms, alternate separators, dot segments, percent and Unicode decoding, archive member names, symlinks, hard links, mount points, and check/use races.

For inclusion, determine whether the selected object is read as data, parsed as a template, or executed. Test wrappers or remote sources only when the deployed runtime supports them.

## Archive Extraction

Constrain:

- total expanded bytes and compression ratio;
- member count, nesting, recursion, and overlapping data;
- normalized member paths;
- symlink and hard-link targets;
- special and sparse files, permissions, ownership, and extended attributes;
- duplicate members and overwrite order;
- disk, memory, CPU, and wall-clock budget.

Extract into a fresh isolated directory and publish atomically after full validation.

## Rare but Productive Hints

- Validate both central-directory metadata and local archive headers; some tools trust different copies.
- Inspect post-processing filenames generated from embedded metadata, not only the upload filename.
- Derived thumbnails, OCR output, previews, and converted documents often use a different authorization key than the original.
- Deduplication by attacker-visible hash or object identity can cross tenant boundaries.
- Quarantine and retry queues can preserve an unsafe file after the user-visible rejection path.
- Temporary paths become attacker-influenced when a predictable job or tenant ID is embedded in the name.
