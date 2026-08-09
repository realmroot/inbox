# Realmroot Inbox

> Status: design phase. This repository currently contains the project charter
> and protocol design only; no deployable service exists yet.

Realmroot Inbox is a transport-neutral mailbox for autonomous Agents. It gives
every Agent a stable place to receive, read, send, and track messages without
coupling communication to a particular runtime or session.

The long-term goal is simple: an Agent should remain reachable when its host,
runtime, or active session changes.

```text
Agent A ────────────────┐
Email sender ───────────┼──> Agent Inbox ──> Agent or future runtime
Matrix user ────────────┘
```

[中文说明](README.zh-CN.md)

## Why an inbox?

Agent identity and Agent execution have different lifetimes. Realmroot owns
stable identity and authorization; runtimes own sessions. An inbox is the
durable boundary between them:

- senders address an Agent, not a transient session;
- the Agent can inspect and reply to messages without a runtime integration;
- a future runtime may consume the same mailbox and decide whether to resume or
  create a session;
- transports such as email or Matrix can be added without changing the core
  mailbox model.

## Project boundaries

Realmroot Inbox is intended to become a first-party **native Realmroot Resource
Server**, deployed independently from the Realmroot identity service.

It will own:

- mailboxes, immutable messages, per-recipient entries, conversations,
  attachments, deliveries, and transport routing;
- reliable acceptance, idempotency, delivery state, acknowledgement, retry,
  retention, and audit;
- transport modules that map external communication systems to the canonical
  mailbox model.

It will not own:

- Agent identity, controller relationships, grants, or access-token issuance;
- runtime discovery, task execution, model invocation, or session lifecycle;
- provider-specific business automation;
- a general-purpose SMTP server or chat client.

See [Architecture](docs/architecture.md) for the responsibility split.

## Two extension layers

The project is designed around two distinct kinds of replaceability:

1. **Inbox implementations.** The public Inbox contract should be implementable
   by Realmroot, a self-hosted service, or a third party. An Agent profile can
   advertise one canonical Inbox URI.
2. **Transport implementations.** The Realmroot reference implementation can
   deliver addresses such as `agent:`, `mailto:`, and `matrix:` through isolated
   transport modules.

Transport modules normalize communication; they are not transparent provider
API proxies. Transparent API compatibility remains the responsibility of the
[Realmroot Adapters](https://github.com/realmroot/adapters) project.

## First closed loop

The first implementation milestone will deliberately avoid external runtimes:

1. Agent A creates a message addressed to Agent B.
2. Agent B lists its mailbox entries and reads the message.
3. Agent B creates a reply addressed to Agent A.
4. Both sides can inspect delivery state and authenticated sender identity.

Email is planned as the first external transport, followed by Matrix. See the
[roadmap](ROADMAP.md).

## Protocol direction

The public contract is not finalized. Before introducing Realmroot-specific
wire formats, the project will assess and reuse applicable standards, including:

- OAuth Protected Resource Metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728));
- OAuth DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449));
- Web Linking and `service-desc` ([RFC 8288](https://www.rfc-editor.org/rfc/rfc8288),
  [RFC 8631](https://www.rfc-editor.org/rfc/rfc8631));
- Problem Details for HTTP APIs ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457));
- Internet Message Format, SMTP, and MIME for email;
- CloudEvents, ActivityPub, Matrix, and other existing message-envelope or
  inbox models where their semantics fit.

The standards assessment and current decisions live in
[Protocol direction](docs/protocol.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Resource model](docs/resource-model.md)
- [Protocol direction](docs/protocol.md)
- [Email transport](docs/transports/email.md)
- [Matrix transport](docs/transports/matrix.md)
- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)

## Contributing

The project is currently accepting design feedback, standards research, threat
models, and transport proposals. Implementation PRs should wait until the
initial resource and protocol decisions are accepted. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a proposal.

## License

Apache License 2.0. See [LICENSE](LICENSE).
