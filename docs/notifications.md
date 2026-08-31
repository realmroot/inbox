# Notification subscriptions

Inbox can notify Realmroot Agency that a committed Message exists without
granting Agency access to its content or deciding how Agency routes runtime
work.

## Responsibility and authorization boundary

Subscription is an Inbox resource. Agency manages it with its existing
Realmroot M2M service identity and Realmroot-issued Bearer access tokens for the
exact Inbox audience. Inbox accepts only the configured `AGENCY_CLIENT_ID` and
the operation's exact `subscriptions:read` or `subscriptions:manage` scope.

This is the only M2M authorization boundary. Inbox does not require a
Controller Grant, delegated Agent authority, reverse M2M credential, or an
Agency credential for callback delivery. Message reads remain separately
authorized Agent operations.

## Subscription contract

Agency generates a stable identifier for each subscription. Creation and full
replacement use the same canonical URI:

```http
PUT /api/subscriptions/sub_0123456789abcdef0123456789abcdef
API-Version: 2026-08-11
Authorization: Bearer <realmroot-agency-access-token>
If-None-Match: *
Content-Type: application/json

{
  "agentId": "019feeeb-6504-74ec-bfdc-da5259f73fc1",
  "events": ["message.created"],
  "delivery": {
    "url": "https://agency.example/inbox-events",
    "authorization": {
      "scheme": "bearer",
      "token": "<agency-generated-callback-token>"
    }
  }
}
```

Creation requires `If-None-Match: *`. Replacement sends the complete body with
the current `If-Match` validator. In particular, every replacement supplies the
complete delivery configuration and a callback token; omission never means
"keep the old token." Deletion also requires `If-Match`.

The callback token is write-only. Inbox encrypts it with AES-256-GCM and the
`DELIVERY_SECRET_KEY` Worker secret. `GET /subscriptions`,
`GET /subscriptions/{subscriptionId}`, creation responses, errors, and logs
never return its plaintext. A read represents delivery authorization as:

```json
{
  "url": "https://agency.example/inbox-events",
  "authorization": { "scheme": "bearer" }
}
```

Delivery URLs must use HTTPS. Tokens never appear in URLs.

## Notification contract

For every matching committed Message, Inbox posts one event shape to the
Subscription's current delivery URL:

```http
POST /inbox-events
Authorization: Bearer <registered-callback-token>
Content-Type: application/json

{
  "eventId": "evt_47037f434ffd00a8aa8bcbfce4484b97",
  "type": "message.created",
  "subscriptionId": "sub_0123456789abcdef0123456789abcdef",
  "agentId": "019feeeb-6504-74ec-bfdc-da5259f73fc1",
  "messageId": "msg_0123456789abcdef0123456789abcdef",
  "routingKey": "trigger_01HXYZ",
  "occurredAt": "2026-08-31T01:00:00.000Z"
}
```

`routingKey` is optional opaque Message metadata supplied by the producer.
Inbox stores and forwards it without interpretation. It does not create a
Conversation or Session from that value.

Notifications contain no subject, body, attachments, callback secret, or raw
transport payload. After waking, the Agent continues to pull Message content
through the Inbox API or Toolbox under its own authority.

## Reliability and lifecycle

Message acceptance and notification-event insertion share one D1 batch
transaction. Inbound email becomes visible and inserts its event only after its
attachments are durably stored. The scheduled delivery worker claims persisted
events with a finite lease, so process termination returns abandoned work to a
later worker.

Delivery is at-least-once:

- every retry keeps the same `eventId`;
- any `2xx` response completes delivery;
- timeout, network failure, `429`, and `5xx` retry with bounded backoff;
- other HTTP responses are permanent failures;
- delivery stops after eight attempts and retains terminal `delivered` and
  `failed` rows for 30 days of operator inspection;
- logs record event, subscription, attempt, result, status, and duration, but
  never callback tokens or Message bodies.

Replacing a Subscription changes the sink and token used by still-pending
events. Deleting it revokes delivery and atomically removes its queued and
historical notification events. Agency must deduplicate by `eventId` and use
Inbox Message listing as the reconciliation path after downtime.

## Deployment configuration

Set both values per Worker environment before deploying:

```bash
pnpm exec wrangler secret put AGENCY_CLIENT_ID
pnpm exec wrangler secret put DELIVERY_SECRET_KEY
```

`DELIVERY_SECRET_KEY` is exactly 32 random bytes encoded as Base64, for example
from `openssl rand -base64 32`. The current schema stores one active key
version. Rotation therefore requires pausing scheduled delivery, deploying the
new key, replacing every Subscription token so it is re-encrypted, and only
then resuming delivery.
