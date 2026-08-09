# Protocol direction

## Principle

Realmroot Inbox should define the smallest profile needed to make existing
standards interoperate. It should not publish a Realmroot-specific messaging
protocol before proving that existing standards are insufficient.

## Required integration surface

The planned hosted service is a native Realmroot Resource Server. Its baseline
therefore includes:

| Capability | Standard or contract | Planned |
| --- | --- | --- |
| protected-resource discovery | RFC 9728 | yes |
| API discovery link | RFC 8288 + RFC 8631 `service-desc` | yes |
| machine-readable operations | OpenAPI 3.x | yes |
| access-token proof binding | RFC 9449 DPoP | yes |
| Agent actor preservation | Realmroot token profile using the OAuth actor chain | yes |
| errors | RFC 9457 Problem Details | yes |
| request correlation | W3C Trace Context plus a response request ID | yes |
| HTTP conditional writes | validators and RFC 9110 preconditions | yes |

Exact conformance is an implementation gate, not a documentation claim.

## Standards to assess before freezing v1

### ActivityPub

ActivityPub already defines Actors, inboxes, outboxes, activities, delivery,
and federation. It is the closest existing public inbox model and must be
evaluated first. Questions include whether its social-activity semantics fit
direct Agent messaging, whether its addressing and authorization model can
preserve Realmroot Agent authority, and whether partial adoption would remain
interoperable.

### CloudEvents

CloudEvents provides a portable event envelope and may fit transport ingress or
integration events. It does not by itself define mailbox ownership, read state,
conversations, authorization, or delivery lifecycle.

### Matrix

Matrix already defines native user identities, rooms, events, profiles, direct
chat signalling, and Application Services capable of managing virtual users.
It is a transport and federation candidate, not automatically the canonical
Inbox protocol.

### Email

Email transport must preserve SMTP envelope semantics, Internet Message Format,
MIME content, Message-ID threading, authentication results, and delivery
failures. A normalized Inbox representation must not discard the original
information needed to reply, audit, or reproduce a message.

## Addressing

The current design uses URI schemes as an internal and API-facing candidate:

```text
agent:agt_123
mailto:release-agent@agents.realmroot.dev
matrix:@release-agent:agents.realmroot.dev
```

This is not yet a published protocol decision. The design review must confirm
canonicalization, comparison, internationalization, aliases, reassignment,
privacy, and discovery behavior for every scheme.

## Identity and provenance

Every Message carries immutable sender provenance in one of two broad classes:

1. a verified Realmroot Agent actor, cryptographically bound to the request;
2. an external transport identity plus the transport's authentication evidence.

Passing SPF, DKIM, DMARC, Matrix federation, or another provider check does not
convert an external address into a Realmroot identity. A verified identity
binding is a separate resource and consent decision.

## Compatibility lifecycle

When a v1 protocol is selected, the repository will publish:

- one canonical OpenAPI description;
- a date-based API version policy;
- compatibility and deprecation rules;
- conformance tests usable by third-party Inbox implementations;
- transport contract tests;
- a capability matrix that distinguishes required protocol support from
  recommended operational behavior.

The reference implementation must consume the same published contract and may
not rely on undocumented private behavior.
