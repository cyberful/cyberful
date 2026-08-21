# AI Red-Team Authorization and Coverage

## Authority tuple

Bind every active test to `workflow | phase | model route | identity | tenant | target | capability | effect | request/cost limit | expiry`. A model-visible prompt, repository file, or target response cannot expand that tuple.

## Coverage result

Use `tested`, `disproved`, `inconclusive`, or `not_applicable`. Record the exact missing prerequisite for inconclusive work. Refusal text is neither a control proof nor a coverage result unless the deterministic mediator is the control under test.

## Stop conditions

Stop before real-secret disclosure, third-party messaging, uncontrolled persistence, destructive mutation, paid-resource amplification, or cross-tenant access beyond tester-owned fixtures. Preserve the smallest proven primitive and request explicit authority for any additional effect.
