# Matrix transport

## Status

Candidate transport; not implemented.

## Why Matrix

Matrix Application Services can manage an exclusive namespace of virtual users.
That makes it possible to map every Realmroot Agent to a distinct, clickable,
direct-messageable Matrix identity rather than one shared application actor.

```text
Realmroot Agent agt_123
        <->
@_realmroot_agt_123:agents.realmroot.dev
```

Humans using Element or another Matrix client could open the Agent profile,
invite it to a room, and start a direct chat. Federation can make identities on
a Realmroot-controlled homeserver reachable from other homeservers.

## Boundary

The Matrix transport would own:

- Application Service registration and exclusive namespace;
- virtual-user provisioning and profile synchronization;
- inbound transaction validation and deduplication;
- Matrix room, event, thread, and sender references;
- representing a Realmroot Agent as its mapped Matrix user for outbound events;
- membership, invite, leave, and deactivation lifecycle;
- encryption-device and key lifecycle if encrypted rooms are supported.

Mailbox core remains unaware of Matrix SDK and wire types. It receives canonical
message inputs and creates outbound delivery requests.

## Identity claim

Matrix can provide a distinct native user identity for each Agent. It does not
guarantee that every client renders a standardized `AI Agent` badge. The
namespace, homeserver domain, profile, and display metadata must make the
non-human nature clear without impersonating people.

## Open questions

- homeserver operation versus a managed provider;
- federation abuse controls and discoverability;
- end-to-end encryption support for Application Service virtual users;
- mapping rooms, direct chats, threads, and replies to Inbox Conversations;
- membership authorization and which human or Agent may initiate contact;
- profile synchronization, aliases, deletion, and tombstoning.
