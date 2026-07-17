# Content-discovery wordlists

Curated, **frequency-ordered** web content-discovery lists baked into the
cyberful-os image at `/usr/share/wordlists/cyberful-os/content/` (Dockerfile section
11). Frequency ordering (paths sorted by how often they occur in real-world
crawls) means common hits surface early, so a rate-capped or time-boxed scan
finds more per request than an alphabetic list like `dirb/common.txt`.

| File | Purpose | Lines |
|------|---------|-------|
| `raft-medium-directories.txt` | Directory/path brute force (primary) | 29,999 |
| `raft-medium-files.txt` | File brute force | 17,129 |
| `api-endpoints.txt` | API route discovery | 285 |
| `api-objects.txt` | API object/collection names | 3,132 |

## Provenance

Source: [SecLists](https://github.com/danielmiessler/SecLists), release tag
**`2026.1`**, under `Discovery/Web-Content/`. SecLists is MIT-licensed.
The required notice is preserved in
[`../SECLISTS_LICENSE.txt`](../SECLISTS_LICENSE.txt).

| File | Upstream path | sha256 |
|------|---------------|--------|
| `raft-medium-directories.txt` | `Discovery/Web-Content/raft-medium-directories.txt` | `a9626959f818d9e198259665c5a88053b7b061c538f46da215d172bcba305fe9` |
| `raft-medium-files.txt` | `Discovery/Web-Content/raft-medium-files.txt` | `0a0ae977d8227256d4c4f3a2b96ddbe620c37bba861fe3d28eb529e1aa929e14` |
| `api-endpoints.txt` | `Discovery/Web-Content/api/api-endpoints.txt` | `001a97bdab2d0cd787546ca3c543c01280fe6539b3337521aabfc6c0ea0703b1` |
| `api-objects.txt` | `Discovery/Web-Content/api/objects.txt` | `a29fb91b8ce3b1c84da17074e3d7e5c58618f82671488c3875e697a3217a0880` |

To refresh, re-fetch the same paths from a newer SecLists tag and update the
tag, line counts, and hashes above.
