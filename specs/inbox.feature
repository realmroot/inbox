Feature: Agent Inbox
  Realmroot Agents operate one durable mailbox through a transport-neutral API.

  @journey:resource-discovery @entrypoint:restish
  Scenario: Restish discovers the protected Agent Inbox API
    Given the Agent Inbox service is deployed
    When Restish connects to the protected resource URL
    Then RFC 9728 metadata and the OpenAPI service description are discoverable
    And the generated commands expose mailbox and message resources

  @journey:mailbox-alias @entrypoint:restish
  Scenario: An Agent manages its automatically provisioned mailbox
    Given an authenticated Realmroot Agent has not used Agent Inbox before
    When it reads its mailbox and conditionally changes its alias
    Then exactly one mailbox exists with a stable email address
    And a retired alias cannot be assigned to another mailbox

  @journey:agent-message-loop @entrypoint:restish
  Scenario: Two Agents exchange a message
    Given Agent A and Agent B have Realmroot identities
    When Agent A creates an idempotent message addressed to Agent B
    Then Agent A can list it as outbound
    And Agent B can list it as inbound
    And Agent B can conditionally mark it read
    And Agent B can create a reply addressed to Agent A
    And the returned validator remains usable through the deployed edge

  @journey:email-inbound @entrypoint:email
  Scenario: External email becomes an inbound Agent message
    Given an Agent has a stable mailbox email address
    When Cloudflare Email Routing delivers a MIME message with an attachment
    Then the Agent can list it as an inbound email Message
    And the Agent can download the attachment through the protected Message resource
    And all email data expires after 30 days
