# Roadmap

This roadmap communicates intent, not delivery dates.

## Phase 0 — protocol and threat model

- [x] establish project boundary and deployment independence;
- [x] define the candidate resource inventory;
- [x] separate Inbox implementation and Transport extension contracts;
- [ ] complete ActivityPub, CloudEvents, email, and Matrix standards assessment;
- [ ] publish threat model and abuse model;
- [ ] decide canonical addressing and Agent Inbox discovery;
- [x] freeze the v1 resource model and API version policy;
- [x] publish conformance criteria for a native Realmroot Resource Server.

## Phase 1 — Agent-to-Agent closed loop

- [x] Realmroot DPoP authentication and Agent actor preservation;
- [x] one canonical mailbox per Agent;
- [x] immutable message creation with idempotency;
- [x] cursor-paginated messages with direction filtering;
- [x] read and archive state with conditional writes;
- [x] reply relationships and delivery summaries;
- [ ] audit, retention, abuse limits, and conformance tests;
- [x] register and verify the hosted native Resource Server.

No runtime or session integration is required for this phase.

## Phase 2 — email

- [x] stable Agent email addressing and aliases;
- [x] inbound Email Routing transport;
- [x] MIME parsing and attachment storage;
- [ ] outbound transactional email delivery;
- [ ] bounce, complaint, suppression, and delivery status;
- [ ] SPF, DKIM, DMARC, spam, malware, quota, and loop controls;
- [ ] end-to-end send, receive, reply, and failure acceptance tests.

## Phase 3 — Matrix

- [ ] Realmroot Agent to Matrix virtual-user mapping;
- [ ] Application Service namespace and provisioning;
- [ ] direct chat, rooms, replies, threads, and lifecycle events;
- [ ] federation and abuse controls;
- [ ] decide and implement the encrypted-room profile;
- [ ] verify each Agent appears as a distinct native Matrix identity.

## Later candidates

- Mattermost Bot Accounts;
- Zulip Bot users;
- Slack shared AI App projection;
- Telegram and Discord where per-Agent provisioning becomes viable;
- runtime consumer subscriptions and session routing, as a separate project or
  integration after the mailbox protocol is stable.

## Retirement principle

A Transport exists only to bridge a platform's native communication model to
the Inbox contract. If a platform natively implements the required Agent Inbox
and identity protocol, the corresponding Transport should be marked deprecated,
given a migration path, and retired.
