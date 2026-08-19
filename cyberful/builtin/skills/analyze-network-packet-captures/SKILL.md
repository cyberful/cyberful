---
name: analyze-network-packet-captures
description: Parse bounded classic PCAP files offline into deterministic capture metadata, packet-length and timestamp summaries, link and network protocol counts, truncation indicators, and source digests without contacting any endpoint.
metadata:
  domain: evidence-analysis
  subdomain: network-captures
  triggers:
    - analyze network packet capture
    - inspect pcap evidence
    - summarize packet capture offline
    - packet length analysis
    - capture truncation review
    - protocol distribution evidence
  tags:
    - pcap
    - packet-analysis
    - network-evidence
    - offline-analysis
    - protocol-inventory
    - capture-integrity
  frameworks:
    mitre_d3fend:
      - D3-NTA
    nist_csf:
      - DE.CM-01
      - DE.AE-03
---

# Analyze Network Packet Captures

Use this skill to establish what a bounded capture contains before deeper protocol interpretation. The packaged analyzer reads classic PCAP only; it does not execute dissectors, resolve names, open sockets, or infer a vulnerability from packet metadata.

## Establish capture integrity

Read [references/packet-evidence-method.md](references/packet-evidence-method.md). Stage [scripts/analyze_network_packet_captures.py](scripts/analyze_network_packet_captures.py), [assets/packet-capture-analysis.example.json](assets/packet-capture-analysis.example.json), and [assets/packet-capture-analysis.schema.json](assets/packet-capture-analysis.schema.json). It snapshots confined regular files, verifies record boundaries and configured cumulative limits, and emits [assets/packet-capture-evidence.schema.json](assets/packet-capture-evidence.schema.json).

Use source digests, PCAP byte order and timestamp precision, snap length, link type, packet counts, captured/original byte totals, time bounds, length buckets, and shallow protocol counts to decide whether evidence is complete enough for a question. Truncation, non-monotonic timestamps, unknown link types, or unsupported formats are evidence-quality facts, not attack findings.

## Escalate deliberately

When packet payload or state-machine interpretation is required, preserve the original capture and use an authorized packet-analysis toolchain under a separate procedure. Correlate network observations with application and server telemetry before assigning causality.
