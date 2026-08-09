# Email transport

## Status

Inbound Email Routing is implemented. Outbound email is not part of v1.

## Product outcome

Each Agent advertises a stable email address and may configure one alias. Email
received at either address becomes an inbound Message. Retired aliases are
never reassigned.

The first delivery to a stable address verifies the Agent through Realmroot and
creates its mailbox when the Agent has never accessed Inbox. Aliases never
trigger mailbox provisioning because they exist only after mailbox setup.

An example future profile may expose both a stable address and a mutable alias:

```text
agt_01kxyz@agents.realmroot.dev
release-agent@agents.realmroot.dev
```

The stable address remains tied to the Agent ID. Alias reassignment requires an
explicit lifecycle and must not silently redirect an existing identity.

## Boundary

The Email transport owns:

- inbound email handler and recipient resolution;
- bounded MIME parsing and preservation of raw mail where policy requires it;
- SMTP envelope and header distinction;
- Message-ID, In-Reply-To, and References threading data;
- SPF, DKIM, DMARC, spam, malware, and abuse evidence;
- outbound message construction and provider submission;
- bounce, complaint, suppression, and provider delivery correlation.

Mailbox core owns message acceptance, authorization, recipient entry state,
retention policy, attachments as protected resources, and the stable Delivery
lifecycle.

## Planned Cloudflare reference path

The initial reference implementation is expected to use one Worker project:

```text
Cloudflare Email Routing -> email() -> Email transport -> Mailbox core
Outbound email is intentionally absent from v1
```

Cloudflare remains the underlying email infrastructure; this project does not
implement an SMTP server.

## Data preservation

The canonical Message may expose safe, normalized fields, while email-specific
details remain isolated and linked:

- envelope sender and recipients;
- header From, To, Cc, and Reply-To;
- subject;
- text and HTML alternatives;
- Message-ID and threading headers;
- content IDs and inline attachments;
- transport authentication results;
- raw-message object reference, subject to retention and privacy policy.

External email senders remain external identities. Authentication evidence is
displayed and auditable but is not promoted to Realmroot authority.

## Abuse and execution safety

An accepted email must not automatically execute an Agent. The mailbox can
accept, quarantine, or reject it according to policy. A future runtime consumer
will independently decide whether an entry starts work.

The transport must define limits for message size, attachment count and decoded
size, recipient count, sending rate, retries, auto-reply loops, and untrusted
content. Permanent validation or policy failures are never retried.
