# Changelog

## Unreleased

- Hardened the public Cyberful Agent Skill against credential confusion, indirect prompt injection, and unrequested high-impact actions by distinguishing public run selectors from authentication secrets, treating target-derived values as untrusted data, making observation the default, and keeping target interaction inside Cyberful's mediated runtime.

## 0.4.0

- Added the public `skills/cyberful` Agent Skills package, `SessionInspectionV1`, `cyberful session inspect`, and the attached `cyberful session watch` control-room stream.
- Changed `cyberful run --format json` to the breaking, explicitly versioned `CyberfulObservationV1` JSONL wire. It no longer emits raw message parts, reasoning, or tool input/output. Outcome exit codes are unchanged: success and warning exit 0; blocked and failed exit 1.
- Fixed workflow completion so the final Report frames flush before idle, the running Report marker clears atomically, and the TUI returns to `Ready` instead of remaining `Working` after report delivery.
- Removed the allowed-domain filter from the public-research `search` browser profile and rejected `allowedDomains` and `--allowed-domains`, including nested batch arguments. Public research does not authorize target interaction or expand scope; numbered target profiles remain ZAP-routed and fail closed.
- Replaced automated dependency-version pull requests with repository-owned `inventory`, `audit`, and `verify` commands so dependency families can be reviewed and validated coherently before updates.
- Improved the hypothesis detail dialog so its stable ID and complete wrapped description remain visible together with state and owning phase.
