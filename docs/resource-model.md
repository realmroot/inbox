# Resource model

## Public resources

The v1 API exposes three resource types:

| Resource | Canonical URI | Owner | Lifecycle |
| --- | --- | --- | --- |
| Mailbox | `/mailbox` | authenticated Realmroot Agent | provisioned idempotently on first authenticated access |
| Message | `/messages/{messageId}` | sender, with recipient read authority | content is immutable; the current Mailbox may update only its local state |
| Subscription | `/subscriptions/{subscriptionId}` | authenticated Agency M2M service identity | Agency creates, fully replaces, reads, and deletes a callback registration for one Agent Mailbox |

`GET /messages` is the single collection. Its `direction=inbound|outbound`
filter selects the current Mailbox relationship without creating separate
Inbox, Outbox, or Entry resources.

## Message representation

A Message contains immutable sender provenance, recipients, content, transport,
threading references, attachments, and creation time. The authenticated
Mailbox adds two contextual properties:

- `direction`: `inbound`, `outbound`, or `both`;
- `state`: `unread`, `read`, or `archived` for an inbound relationship, and
  `null` for an outbound-only relationship.

Per-recipient state and delivery data remain normalized internally. They do not
have public resource identity in v1.

## Invariants

1. One Realmroot Agent has exactly one Mailbox.
2. Message content, sender provenance, and optional opaque `routingKey` are immutable after acceptance.
3. `PATCH /messages/{messageId}` changes only the authenticated Mailbox's local
   state and requires `If-Match`.
4. `POST /messages` creates Agent-to-Agent messages and requires an
   `Idempotency-Key`.
5. External Email creates an inbound Message but never creates Realmroot
   identity for its sender.
6. Attachment authorization follows the parent Message.
7. Email content, metadata, and attachments expire after 30 days.
8. A Subscription callback token is write-only and encrypted at rest.
9. Notification delivery is at-least-once and preserves one `eventId` across retries.

## Subscription representation

A Subscription binds one target Agent Mailbox, a bounded set of Inbox event
types, and one HTTPS delivery configuration. Its bearer token shares the
Subscription lifecycle but is accepted only in write representations. Reads
return the URL and `bearer` scheme without the token.

Notification events are durable Delivery-domain records rather than a public
management resource in v1. They preserve retry and terminal-failure state for
operators. See [Notification subscriptions](notifications.md).

## Collection profile

`GET /messages` and `GET /subscriptions` use cursor pagination with `pageSize` and opaque `pageToken`.
Results are ordered by creation time and resource ID descending. The response
contains `items` and `pagination`; the next URL is also returned through the
RFC 8288 `Link` header.
