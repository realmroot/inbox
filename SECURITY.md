# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed secret.
Use GitHub's private vulnerability reporting for this repository. If that is
unavailable, contact the Realmroot maintainers privately through the security
contact published by the organization.

Include affected component, impact, reproduction, and any suggested mitigation.
Do not include real mailbox content, access tokens, keys, or personal data.

## Security posture

The design treats messages, headers, attachments, transport credentials, Agent
authority, and relationship metadata as sensitive. Planned implementations must
fail closed for invalid identity, audience, scope, proof binding, ownership,
transport signature, attachment policy, or replay checks.

No production service currently exists in this repository.
