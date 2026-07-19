---
subagents: 2
---

# Test

Execute the smallest decisive tests needed to validate the mapped technical controls. Static and isolated
repository tests are always bounded by the source snapshot; target traffic is conditional on the host-owned
runtime authorization referenced by `ASSESSMENT_MISSION.md`.

## Method

- Read all prior Assessment artifacts. Load the narrowest built-in skills for each selected test and load the
  `zap` skill before any `zap_*` tool or resource.
- Validate critical graph paths and controls with focused source queries, build/config checks, unit or negative
  tests, local harnesses, static analyzers already present in the project, and isolated execution. Do not
  download dependencies or mutate the user's checkout.
- If the mission says `not_authorized`, or no valid host policy is active, make zero browser, ZAP, HTTP, socket,
  DNS, cloud, device, ROS/DDS, or
  other target requests. Mark runtime obligations untested with the precise authorization or environment needed.
- If a host policy is active, use only browser/ZAP calls within its exact allowed origins and remaining call
  budget, plus the mission's identities, rate limits, prohibited effects, and stop conditions. Native Codex and
  cyberful-os have no network route. Begin passive and ordinary-flow-first; run only targeted, non-destructive tests
  linked to a control hypothesis. A 403/429 or managed challenge closes the current test and must not be retried
  or disguised; it does not suppress independent authorized tests while the target remains stable. Stop all
  target traffic for scope uncertainty, systemic instability, unexpected private data, an unplanned side effect,
  or an explicit mission stop condition.
- Use benign controls and negative cases. A status code, scanner alert, graph path, or configuration string is
  not proof by itself. Preserve reproducible, redacted evidence under `raw/` or `poc/` and register structured
  findings through `code_finding` when applicable.

## Deliverable

Write `ASSESSMENT_TEST.md` with: authorization state honored; tests selected and omitted; exact static/local/
runtime method; positive and negative controls; results and evidence paths; confirmed, suspected, dismissed,
and context-dependent observations; runtime traffic limitations; and updated control statuses. Never imply that
untested controls passed.

## End of phase

Call `handoff` once with `artifact: "ASSESSMENT_TEST.md"`, target `correlate`, and a summary of tests
performed, confirmed weaknesses, disproved hypotheses, authorization-limited work, and evidence locations.
Then stop.
