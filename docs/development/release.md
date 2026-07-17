# Release policy

Cyberful publishes `@cyberful/cli` plus platform packages for macOS arm64/x64,
Linux x64, and Windows x64. x64 packages contain normal and baseline binaries;
the launcher selects the compatible binary at install time.

Stable releases are planned from conventional commit titles. `fix` selects a
patch, `feat` a minor, and a breaking marker a major; a manual bump may raise
but not lower the inferred impact. The first public version is `0.1.0`.
Documentation, tests, and CI-only changes do not independently trigger a
runtime release.

The scheduled weekday workflow and manual dispatch both:

1. select an immutable commit and calculate a version;
2. run the full verification suite;
3. build native packages for every supported target;
4. stage npm packages and native archives;
5. generate an SPDX SBOM and SHA-256 checksums;
6. create an annotated tag and draft GitHub release;
7. attach build provenance and publish with npm trusted publishing;
8. make the GitHub release public only after all publication checks succeed.

Release archives include the AGPL license, third-party notices, and the font
and wordlist license texts. A partial release is resumed from its original tag
and commit instead of rebuilding a different source state under the same
version. Use the workflow's `dry_run` input to exercise assembly without
tagging or publication.
