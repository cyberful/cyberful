# Kubernetes policy proof

## Four layers

1. **Intent:** the invariant and workload population the organization expects to protect.
2. **Logic:** the Rego, CEL, or engine policy that evaluates an admission object.
3. **Binding:** match constraints, namespace/object selectors, exclusions, parameters, enforcement action, and failure policy.
4. **Operation:** installed revision, webhook reachability, admission ordering, break-glass paths, and evidence from admitted objects.

Local Conftest results address logic against supplied artifacts. They do not establish binding or operation. Obtain rendered manifests and the exact deployed policy revision when Helm, Kustomize, generators, or mutation can change the evaluated object.

## Exception review

Every exception should identify owner, rationale, exact subject, expiry, compensating control, and removal evidence. Broad namespace or label exclusions are security boundaries, not administrative details.

## Finding classes

- Policy logic accepts an object that violates the stated invariant.
- Binding omits an intended resource, operation, user, namespace, or API version.
- Failure-open or unavailable admission allows protected operations.
- Mutation changes the object after or before the relevant validation assumption.
- Deployment paths bypass the reviewed admission route.

The packaged campaign's `scope_reference` is attribution only. Authority remains the mission and runtime boundary established before the skill is staged; a JSON file cannot authorize access or execution.
