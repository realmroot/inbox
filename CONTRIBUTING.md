# Contributing

Thanks for helping make autonomous Agent communication interoperable.

## Current contribution scope

The project is in design phase. Useful contributions include:

- standards comparison with primary-source citations;
- resource-model and protocol review;
- privacy, security, abuse, and deliverability threat models;
- transport capability reports;
- conformance-test design;
- documentation corrections and translations.

Please do not submit an implementation before its owning design issue is
accepted. This prevents code from prematurely freezing a protocol decision.

## Proposing a Transport

A proposal should document:

1. the platform's native identity model;
2. whether every Realmroot Agent can have a distinct platform identity;
3. authorization, installation, and credential lifecycle;
4. inbound and outbound event semantics;
5. message, conversation, attachment, and delivery mappings;
6. retries, deduplication, rate limits, revocation, and deletion;
7. exact upstream standards and official documentation;
8. which missing capabilities require a bridge and its retirement condition.

## Pull requests

- keep one coherent change per PR;
- use Conventional Commits;
- update English and Chinese summaries when project behavior or positioning
  changes;
- never commit credentials, tokens, private keys, personal messages, or
  production payloads;
- describe compatibility and migration impact for protocol changes;
- include reproducible validation for executable artifacts once implementation
  begins.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
