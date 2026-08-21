---
name: test-email-channel-security
description: Test application email generation, recipient authority, template and header construction, link and token binding, inbound parsing, threading, reply handling, bounce processing, and tenant isolation. Use for email header injection, misdelivery, template confusion, reply-to abuse, magic-link leakage, inbound-email authorization, or security-notification integrity.
metadata:
  domain: application-security
  subdomain: email-channel-security
  triggers:
    - email header injection
    - email recipient authorization
    - magic link security
    - inbound email processing
    - email template injection
    - reply handling security
  tags:
    - email
    - recipient-binding
    - header-injection
    - magic-link
    - inbound-parser
    - notification
  frameworks:
    nist_csf:
      - ID.RA-01
      - PR.PS-01
---

# Test Email Channel Security

Treat email as an asynchronous, multi-parser security channel. Separate application construction, provider transformation, mailbox display, link handling, replies, bounces, and inbound ingestion; each boundary has different identity and parsing rules.

## Build the channel matrix

Use [assets/email-channel-matrix.example.json](assets/email-channel-matrix.example.json) with [assets/email-channel-matrix.schema.json](assets/email-channel-matrix.schema.json). Record trigger, actor, tenant, recipient derivation, sender identity, reply route, template, sensitive fields, links or tokens, provider, inbound correlation, retention, and evidence.

Read [references/email-boundary-model.md](references/email-boundary-model.md). Use only controlled mailboxes and inert markers. Never deliver unsolicited messages or include real secrets in test content.

## Test discriminating controls

Vary one of recipient authority, display data, header-capable input, template context, locale, threading identifiers, reply address, link host, token audience, expiry, forwarding, bounce identity, or inbound sender proof. Verify the actual rendered MIME and final controlled mailbox representation.

## Confirmation standard

Report application trigger, recipient derivation, exact MIME or inbound artifact, parser boundary, current authorization, token or link binding, matched control, delivery or action effect, and affected tenant. Cosmetic rendering differences alone are not security findings.
