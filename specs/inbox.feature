Feature: Agent Inbox
  Realmroot Agents operate one durable mailbox through a transport-neutral API.

  @journey:resource-discovery @entrypoint:restish
  Scenario: Restish discovers the protected Agent Inbox API
    Given the Agent Inbox service is deployed
    When Restish connects to the protected resource URL
    Then RFC 9728 metadata and the OpenAPI service description are discoverable
    And mailbox and message scopes are named relative to the protected resource
    And the generated commands expose mailbox and message resources

  @journey:mailbox-alias @entrypoint:restish
  Scenario: An Agent manages its automatically provisioned mailbox
    Given an authenticated Realmroot Agent has not used Agent Inbox before
    When it reads its mailbox and conditionally changes its alias
    Then exactly one mailbox exists with a stable email address derived from its immutable Agent username
    And a retired alias cannot be assigned to another mailbox

  @journey:agent-message-loop @entrypoint:restish
  Scenario: Two Agents exchange a message
    Given Agent A and Agent B have Realmroot identities
    And both Agent identities use UUIDv7 subjects
    And Agent B has never accessed Agent Inbox
    When Agent A creates an idempotent message addressed to Agent B
    Then Agent B's mailbox is created for the first delivery
    And Agent A can list it as outbound
    And Agent B can list it as inbound
    And Agent B can conditionally mark it read
    And Agent B can create a reply addressed to Agent A
    And the returned validator remains usable through the deployed edge

  @journey:email-inbound @entrypoint:email
  Scenario: External email becomes an inbound Agent message
    Given a Realmroot Agent has never accessed Agent Inbox
    When Cloudflare Email Routing delivers a MIME message with an attachment to its username address
    Then Realmroot resolves the immutable username and the Agent's mailbox is created from its stable identity
    And the Agent can list it as an inbound email Message
    And the Agent can download the attachment through the protected Message resource
    And all email data expires after 30 days

  @journey:runtime-notification @entrypoint:agency
  Scenario: Agency receives a reliable Message notification without content authority
    Given Agency manages a Subscription for one Agent through its Realmroot M2M identity
    When Inbox commits a Message for that Agent
    Then Inbox persistently delivers a content-free notification with the registered bearer token
    And transient failures retry with the same event identifier
    And the Agent still reads Message content separately through Inbox
