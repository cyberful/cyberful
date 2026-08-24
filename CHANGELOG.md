# Changelog

## 0.4.0

- Added the public `skills/cyberful` Agent Skills package, `SessionInspectionV1`, `cyberful session inspect`, and the attached `cyberful session watch` control-room stream.
- Changed `cyberful run --format json` to the breaking, explicitly versioned `CyberfulObservationV1` JSONL wire. It no longer emits raw message parts, reasoning, or tool input/output. Outcome exit codes are unchanged: success and warning exit 0; blocked and failed exit 1.
- Fixed workflow completion so the final Report frames flush before idle, the running Report marker clears atomically, and the TUI returns to `Ready` instead of remaining `Working` after report delivery.
- Removed the allowed-domain filter from the public-research `search` browser profile and rejected `allowedDomains` and `--allowed-domains`, including nested batch arguments. Public research does not authorize target interaction or expand scope; numbered target profiles remain ZAP-routed and fail closed.
