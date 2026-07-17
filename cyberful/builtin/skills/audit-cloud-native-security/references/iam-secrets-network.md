# IAM, Secrets, and Network Boundaries

## Effective IAM Analysis

Expand wildcards against actual resources and sensitive actions. Include:

- identity and resource policies;
- role trust and federation claims;
- permission boundaries and session policies;
- organization, folder, management-group, and project controls;
- service-linked or managed identities;
- conditional keys, tags, regions, networks, and source identity;
- delegation, impersonation, pass-role, and policy mutation.

Search for privilege through composition. Two individually modest permissions can become escalation when one controls code and another attaches an identity.

## Identity Federation

Constrain issuer, audience, subject, tenant, repository, branch, workflow, environment, service account, and session name as applicable. Avoid broad wildcard subjects. Verify the caller cannot choose arbitrary claims through mutable metadata.

## Secret Paths

Inventory secret managers, environment variables, mounted files, CI variables, container layers, image history, IaC state, user data, logs, crash dumps, debug endpoints, backups, and operator resources. Record who can read ciphertext, invoke decryption, update the secret reference, or replace the consuming workload.

## Network Reality

Map public endpoints, private endpoints, peering, transit, service endpoints, egress NAT, DNS, load balancers, firewall inheritance, security groups, network policies, and control-plane access. Verify both IPv4 and IPv6.

Network location is rarely sufficient authorization. Identify services that still trust source network, proxy headers, or default workload identity.

## Advanced Graph Hints

- Updating a function's environment or layer can expose its next-run credentials.
- Passing a role to a build, job, notebook, automation, or serverless service can be equivalent to assuming it.
- Read access to IaC state may disclose secrets and resource identifiers needed for control-plane attacks.
- Ability to alter tags can satisfy tag-based authorization conditions.
- Key-policy administration can bypass restrictions in identity policy.
- Snapshot creation, sharing, export, or restore can bypass direct database read controls.
- Log subscription, tracing, or diagnostic settings can redirect sensitive data to an attacker-controlled sink.
