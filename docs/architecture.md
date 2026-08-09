# Architecture

## Status

The v1 reference service is implemented and deployed independently from
Realmroot. Later transport and runtime integrations remain design proposals.

## Responsibility boundary

```text
┌──────────────────────────────────────────────┐
│ Realmroot                                    │
│ Agent identity, controller, grants, tokens   │
└──────────────────────┬───────────────────────┘
                       │ native authorization
                       ▼
┌──────────────────────────────────────────────┐
│ Agent Inbox                                  │
│ mailbox, message, conversation, delivery     │
└───────────────┬──────────────────┬───────────┘
                │                  │
        transport modules     future consumer
                │                  │
       ┌────────┴────────┐         ▼
       │ Email / Matrix  │   Agent Host / Runtime
       └─────────────────┘   session mapping + execution
```

Realmroot is the authorization control plane. Inbox is the communication data
plane. A runtime is an optional consumer. Keeping these boundaries independent
prevents message volume, retries, attachments, or transport incidents from
affecting sign-in and authorization availability.

## Stable Agent, transient session

Messages target a stable Agent Inbox. They never target a runtime session.

When runtime integration is eventually added, the runtime owns any mapping from
an external conversation to a session:

```text
external conversation key -> Agent ID -> runtime session ID
```

Inbox may preserve the external conversation key as message provenance, but it
must not create, resume, archive, or migrate sessions.

## Reference service

The Realmroot reference implementation is an independently deployed Cloudflare
Worker and a native Realmroot Resource Server. Its storage design includes:

- relational metadata for mailboxes, messages, per-mailbox state, and deliveries;
- object storage for attachments and preserved transport payloads;
- an hourly retention job; outbound transport queues, bounded retries, and dead
  letter handling remain later work;
- no request-scoped mutable global state;
- one structured completion event at each HTTP, email, and queue boundary.

## Internal domains

### Mailbox

Owns the association between one Agent and its messages, mailbox-local
disposition, retention policy, and authorization boundary.

### Messaging

Owns immutable message content, sender provenance, recipients, threading
references, and reply relationships.

### Delivery

Owns each recipient delivery, its attempts, terminal outcome, provider
reference, idempotency, and retry classification.

### Conversation

Owns an optional durable grouping of related messages. A conversation is not a
runtime session and must remain useful without one.

### Transport

Maps between an external communication protocol and canonical mailbox
resources. Transport modules depend on the mailbox-owned ports; the mailbox
core never imports provider SDK or wire types.

## Extension model

Two contracts must remain distinct.

### Inbox implementation contract

Defines how an Agent discovers and operates its mailbox. Multiple services may
implement it. Realmroot's hosted service is only the first-party reference.

### Transport contract

Defines how one Inbox implementation accepts and delivers messages through an
address scheme. Planned examples:

| Scheme | Meaning | Module |
| --- | --- | --- |
| `agent:` | direct Realmroot Agent delivery | built-in Agent transport |
| `mailto:` | Internet email | Email transport |
| `matrix:` | Matrix user or room | Matrix transport |

Inbound protocols keep their own handlers and validation. They converge only
after producing a canonical accepted-message input. Outbound transports consume
a canonical delivery request and return a stable delivery result or failure
classification.

## Consistency and delivery guarantees

The design assumes at-least-once transport delivery. Therefore:

- every accepted message and delivery has a stable identifier;
- caller-controlled message creation requires an idempotency identity;
- inbound provider events retain a provider delivery identifier for dedupe;
- consumers are idempotent;
- database state and required asynchronous publication use an explicit atomic
  consistency design, such as an outbox;
- transient and permanent failures remain distinguishable;
- failed work is never acknowledged as successful.

## Security boundary

Protected operations will authenticate Realmroot-issued, Agent-bound authority
at the HTTP boundary and authorize separately against the addressed mailbox,
message, entry, attachment, or delivery.

The service must preserve:

- the controlling subject and Agent actor as distinct identities;
- `sub_profile: ai_agent` classification;
- exact token audience for the Inbox Resource Server;
- DPoP key binding and replay prevention;
- scope and resource ownership checks;
- immutable sender provenance and transport authentication evidence.

External email or chat identities are not Realmroot identities merely because a
provider authenticated their transport. Linking them requires a separate,
explicitly verified relationship.

## Deployment independence

The project starts as one reference-service repository. Email and later Matrix
remain isolated modules within that service, not separate projects. A transport
may be extracted only when operational scale, ownership, security, or release
cadence provides a concrete reason. The transport port makes that extraction a
deployment change rather than a domain rewrite.
