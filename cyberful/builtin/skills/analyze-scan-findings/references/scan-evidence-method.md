# Scan evidence method

## Preserve source identity

Record scanner and rule versions, configuration, analyzed artifact digest, exclusions, baseline, and execution mode. Hash each export and retain the original result independently of the normalized view.

## Correlate conservatively

Prefer a stable scanner fingerprint tied to rule and code identity. If unavailable, use a transparent structural key from rule, canonical location, and message hash. Never merge solely on message similarity or severity. Preserve every source occurrence and suppression marker.

## Verify mechanism and impact

Inspect source and dataflow, establish reachability from an authorized input or actor, reproduce the mechanism, and confirm the protected effect. Scanner confidence and severity are hints, not proof. Record negative controls and environmental assumptions.

## Track decisions separately

False-positive disposition, duplicate status, accepted risk, remediation owner, and verification outcome are workflow decisions. Keep them outside immutable source evidence so later tool or code changes can be reconciled without rewriting history.
