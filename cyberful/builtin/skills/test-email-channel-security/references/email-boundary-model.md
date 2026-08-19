# Email Boundary Model

## Outbound construction

Trace recipient authority separately from display content. Validate structured address APIs, reject line breaks in header-capable fields, constrain reply routing, contextually encode templates, and bind attachments and links to the intended tenant and purpose.

## Tokens and links

Bind magic links and action tokens to purpose, subject, tenant, audience, canonical host, expiry, and one-time state where required. Test forwarding and mailbox compromise assumptions without using real accounts or secrets.

## Inbound and asynchronous handling

Record provider authentication results, envelope sender, visible sender, recipient alias, threading identifiers, MIME part selection, attachment pipeline, quoting, bounce type, and correlation key. Sender-domain authentication is not application authorization.

## Evidence threshold

Use controlled mailboxes and preserve source MIME. Prove misdelivery, unauthorized action, cross-tenant correlation, header creation, active-content effect, or security-notification suppression; do not infer impact from unusual rendering alone.

