# IaC evidence method

Use this method when scanner output must be tied to effective deployment behavior.

## Provenance chain

Record `source declaration -> variable/default -> module input -> local/expression -> environment overlay -> generated plan or template -> provider resource property`. Stop where a value becomes unknown and request the missing plan, variable set, or generated artifact rather than substituting a guess.

## Control questions

- Does the configuration create a public, cross-account, cross-tenant, or broadly trusted boundary?
- Which identity can deploy or override the property, and are policy checks mandatory on that path?
- Is encryption, logging, retention, immutability, isolation, or deletion protection explicitly set or inherited from a verified platform default?
- Does an exception expire, identify an owner, and remain narrower than the protected resource set?
- Can generated artifacts or environment overlays change the result after the reviewed source is merged?

## Evidence grading

- **Confirmed:** the effective value and deployment path are known, and the violated invariant is observable.
- **Supported:** source and composition indicate the value, but a generated plan or environment input remains missing.
- **Tool-only:** a scanner emitted a check without a resolved value path; retain it as a lead.
- **Not applicable:** the resource is unreachable, disabled, test-only, or protected by a verified external control.

Keep tool output raw. Add interpretation separately so later tool-version or policy changes do not rewrite the original observation.

The packaged campaign's `scope_reference` is attribution only. Authority remains the mission and runtime boundary established before the skill is staged; a JSON file cannot authorize access or execution.
