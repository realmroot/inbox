# Resource model

## Status

Candidate model for protocol design. Canonical HTTP paths and representations
remain subject to standards assessment and contract review.

## Resource inventory

| Resource | Identity | Owner | Lifecycle |
| --- | --- | --- | --- |
| Mailbox | stable Agent ID | addressed Agent | available while the Agent and configured Inbox exist |
| Message | service-generated message ID | sender, with recipient read authority | immutable after acceptance; retained by policy |
| Mailbox Entry | mailbox + entry ID | recipient Agent | unread, read, archived, then expired/deleted by policy |
| Conversation | conversation ID | participating mailbox boundary | created from a message relationship; independent of runtime sessions |
| Delivery | delivery ID | sending Agent, with recipient visibility where appropriate | pending, processing, delivered, failed, or cancelled where supported |
| Delivery Attempt | attempt ID | parent delivery | immutable record of one bounded attempt |
| Attachment | attachment ID | parent message authorization | uploaded, accepted, quarantined, available, or expired |

## Value objects

These concepts do not initially require independent resource identity:

- Address: scheme plus scheme-specific address value;
- Content Part: media type, optional language, disposition, and inline content
  or attachment link;
- Sender Provenance: verified Realmroot actor or external transport identity;
- Transport Reference: provider identifiers required for dedupe, reply, or
  delivery-status correlation.

## Core invariants

1. Message content and authenticated sender provenance are immutable after
   acceptance.
2. A Mailbox Entry belongs to exactly one mailbox and references exactly one
   message.
3. Recipient-specific state belongs to the Mailbox Entry, never the Message.
4. One logical recipient produces one Delivery; multiple recipients do not
   share delivery state.
5. A Conversation is a communication grouping, not an execution session.
6. External transport identifiers never become Realmroot identity without an
   explicit verified binding.
7. Attachment authorization follows the parent Message and cannot be widened by
   possession of an object-storage URL.

## Candidate capability mapping

| User capability | Resource operation |
| --- | --- |
| send a message | create a Message in the sender-authorized collection |
| view inbox | list Mailbox Entries for the authenticated Agent |
| read one message | retrieve the Message referenced by an authorized Entry |
| mark read or archive | conditionally update the Mailbox Entry representation |
| inspect send progress | retrieve Deliveries created for the Message |
| reply | create a new Message with reply and conversation relationships |

No action-oriented routes such as `/send`, `/mark-read`, `/retry`, or `/reply`
are planned. HTTP methods operate on resources.

## Collection profile

Growing collections are expected to use cursor pagination because mailboxes are
append-heavy, may mutate while traversed, and do not require exact total counts.
The eventual contract must define:

- a stable total order with a unique tie-breaker;
- opaque page tokens;
- snapshot or clearly documented consistency semantics;
- bounded page size;
- RFC 8288 pagination links;
- no inferred retry of non-idempotent message creation.

## Idempotency and concurrency

- Message creation will require an idempotency key unless the final protocol
  chooses a caller-controlled URI and idempotent `PUT`.
- Reusing a key with different content is a conflict.
- Mailbox Entry mutation requires a representation validator and conditional
  write.
- Delivery attempts are created by the delivery subsystem, not by an RPC-style
  retry endpoint.

## Open questions

- whether ActivityPub's Actor/Inbox/Outbox model can be adopted directly or
  profiled without semantic distortion;
- whether Conversation is required in the first version or can be derived from
  immutable reply relationships;
- whether sent-message views require an explicit Outbox resource or are a
  queryable relationship over Messages and Deliveries;
- retention and deletion semantics when sender and recipients have different
  policies;
- portable representation of rich content without reducing email or Matrix
  semantics to plain text.
