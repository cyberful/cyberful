# Segmentation test method

PCI DSS v4.0.1 Requirement 11.4.5 applies when segmentation is used to isolate the CDE from other networks. Testing occurs at least every 12 months and after changes to segmentation controls or methods; covers all methods in use; follows the entity's methodology; confirms the controls are operational and effective; confirms isolation from all out-of-scope systems and between differing security levels; and uses a qualified, organizationally independent tester.

Requirement 11.4.6 adds a six-month cadence for service providers and retains testing after changes. Confirm entity type before assigning that cadence. The PCI SSC Penetration Testing Guidance v1.1 remains useful for test design but uses older requirement numbering.

## Build representative coverage

Inventory each unique segmentation mechanism and configuration class before selecting samples. A representative source must exercise the same trust boundary, route, enforcement point, identity context, and configuration path as the population it represents. Record the population and why the sample can expose a shared failure. Do not sample away a unique technology, tenant boundary, administrative plane, wireless path, cloud account, or third-party connection.

## Test invariants

For each case, state a positive isolation invariant such as: `the compromised source cannot initiate or cause traffic, authentication, administration, data access, or control-plane change that reaches the protected CDE capability`. Select bounded discriminators for routing, transport, application, identity, and asynchronous paths. Verify both direct reach and indirect impact through shared services.

Treat a timeout as inconclusive unless the test can distinguish enforcement from packet loss, an absent service, or a test-path defect. Preserve the effective source, destination, protocol, identity, timestamp, command or request, raw bounded response, enforcement evidence, and cleanup result.

If testing contradicts a scope-reduction claim, stop before touching account data, notify the designated owner, and update the CDE ledger. The result may expand assessment scope; Cyberful must not make that governance decision silently.
