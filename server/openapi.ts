import { API_VERSION } from '../shared/contracts'
import { scopeCatalog, scopes } from './policy'

export function openApi(origin: string, issuer: string) {
  const problem = {
    type: 'object',
    required: ['type', 'title', 'status', 'detail', 'instance'],
    properties: {
      type: { type: 'string', format: 'uri' }, title: { type: 'string' }, status: { type: 'integer' },
      detail: { type: 'string' }, instance: { type: 'string' }, requestId: { type: 'string' },
    },
  }
  const message = {
    type: 'object',
    required: ['id', 'direction', 'state', 'sender', 'recipients', 'subject', 'content', 'transport', 'attachments', 'createdAt', 'links'],
    properties: {
      id: { type: 'string', pattern: '^msg_' },
      direction: { type: 'string', enum: ['inbound', 'outbound', 'both'] },
      state: { type: ['string', 'null'], enum: ['unread', 'read', 'archived', null] },
      sender: { type: 'object', required: ['kind', 'address'], properties: { kind: { type: 'string', enum: ['agent', 'email', 'service'] }, address: { type: 'string' } } },
      recipients: { type: 'array', items: { type: 'object', required: ['address', 'deliveryStatus'], properties: { address: { type: 'string' }, deliveryStatus: { type: 'string', enum: ['pending', 'delivered', 'failed'] } } } },
      subject: { type: ['string', 'null'] },
      content: { type: 'object', properties: { text: { type: 'string' }, html: { type: 'string' } } },
      inReplyTo: { type: ['string', 'null'], pattern: '^msg_[0-9a-f]{32}$' },
      transport: { type: 'string', enum: ['agent', 'email'] },
      routingKey: { type: 'string', maxLength: 512, description: 'Opaque producer-supplied routing metadata. Inbox stores and forwards it without interpretation.' },
      attachments: { type: 'array', items: { type: 'object' } },
      createdAt: { type: 'string', format: 'date-time' },
      links: { type: 'object', additionalProperties: { type: 'string', format: 'uri' } },
    },
  }
  const protectedResponseHeaders = { 'Cache-Control': { $ref: '#/components/headers/CacheControl' } }
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 412, 428, 500].map((status) => [status, {
    description: 'Problem Details response.',
    headers: { 'Request-Id': { $ref: '#/components/headers/RequestId' }, 'API-Version': { $ref: '#/components/headers/ApiVersion' }, ...protectedResponseHeaders },
    content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
  }]))
  const version = { name: 'API-Version', in: 'header', required: true, schema: { type: 'string', const: API_VERSION, default: API_VERSION } }
  const security = (scope: string) => [{ RealmrootOAuth: [scope] }]
  const serviceSecurity = (scope: string) => [{ RealmrootServiceOAuth: [scope] }]
  return {
    openapi: '3.1.0',
    info: { title: 'Agent Inbox API', version: API_VERSION, description: 'A transport-neutral mailbox for Realmroot Agents.' },
    servers: [{ url: `${origin}/api` }],
    tags: [{ name: 'mailbox' }, { name: 'message' }, { name: 'subscription' }],
    paths: {
      '/mailbox': {
        get: {
          operationId: 'getMailbox', tags: ['mailbox'], 'x-cli-name': 'show', security: security(scopes.mailboxRead),
          parameters: [version], responses: { 200: { description: 'Current Agent mailbox.', headers: { ETag: { $ref: '#/components/headers/ETag' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Mailbox' } } } }, ...errors },
        },
        patch: {
          operationId: 'updateMailbox', tags: ['mailbox'], 'x-cli-name': 'update', security: security(scopes.mailboxManage),
          parameters: [version, { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/merge-patch+json': { schema: { type: 'object', required: ['alias'], additionalProperties: false, properties: { alias: { type: ['string', 'null'], maxLength: 63 } } } } } },
          responses: { 200: { description: 'Updated mailbox.', headers: { ETag: { $ref: '#/components/headers/ETag' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Mailbox' } } } }, ...errors },
        },
      },
      '/messages': {
        get: {
          operationId: 'listMessages', tags: ['message'], 'x-cli-name': 'list', security: security(scopes.messagesRead),
          parameters: [version,
            { name: 'direction', in: 'query', schema: { type: 'string', enum: ['inbound', 'outbound'] } },
            { name: 'state', in: 'query', schema: { type: 'string', enum: ['unread', 'read', 'archived'] } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'pageToken', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Messages visible to the current mailbox.', headers: { Link: { $ref: '#/components/headers/Link' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Message' } }, pagination: { $ref: '#/components/schemas/Pagination' } } } } } }, ...errors },
        },
        post: {
          operationId: 'createMessage', tags: ['message'], 'x-cli-name': 'send', security: [...security(scopes.messagesCreate), ...serviceSecurity(scopes.messagesCreate)],
          parameters: [version, { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateMessage' } } } },
          responses: {
            200: { description: 'Idempotent replay of the existing Message.', headers: { Location: { $ref: '#/components/headers/Location' }, 'Idempotency-Replayed': { $ref: '#/components/headers/IdempotencyReplayed' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } },
            201: { description: 'Message created.', headers: { Location: { $ref: '#/components/headers/Location' }, 'Idempotency-Replayed': { $ref: '#/components/headers/IdempotencyReplayed' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } },
            ...errors,
          },
        },
      },
      '/messages/{messageId}': {
        get: {
          operationId: 'getMessage', tags: ['message'], 'x-cli-name': 'show', security: security(scopes.messagesRead),
          parameters: [version, { $ref: '#/components/parameters/MessageId' }], responses: { 200: { description: 'Message.', headers: { ETag: { $ref: '#/components/headers/ETag' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } }, ...errors },
        },
        patch: {
          operationId: 'updateMessage', tags: ['message'], 'x-cli-name': 'update', security: security(scopes.messagesManage),
          parameters: [version, { $ref: '#/components/parameters/MessageId' }, { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/merge-patch+json': { schema: { type: 'object', required: ['state'], additionalProperties: false, properties: { state: { type: 'string', enum: ['unread', 'read', 'archived'] } } } } } },
          responses: { 200: { description: 'Updated mailbox-local message state.', headers: { ETag: { $ref: '#/components/headers/ETag' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Message' } } } }, ...errors },
        },
      },
      '/messages/{messageId}/attachments/{attachmentId}': {
        get: {
          operationId: 'getMessageAttachment', tags: ['message'], 'x-cli-name': 'attachment', security: security(scopes.messagesRead),
          parameters: [version, { $ref: '#/components/parameters/MessageId' }, { name: 'attachmentId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Attachment body.', headers: protectedResponseHeaders, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...errors },
        },
      },
      '/subscriptions': {
        get: {
          operationId: 'listSubscriptions', tags: ['subscription'], 'x-cli-name': 'list', security: serviceSecurity(scopes.subscriptionsRead),
          description: 'Lists notification Subscriptions owned by the authenticated Agency service identity. Callback bearer tokens are never returned.',
          parameters: [version,
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'pageToken', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Agency-owned notification Subscriptions.', headers: { Link: { $ref: '#/components/headers/Link' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { type: 'object', required: ['items', 'pagination'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Subscription' } }, pagination: { $ref: '#/components/schemas/Pagination' } } } } } }, ...errors },
        },
      },
      '/subscriptions/{subscriptionId}': {
        get: {
          operationId: 'getSubscription', tags: ['subscription'], 'x-cli-name': 'show', security: serviceSecurity(scopes.subscriptionsRead),
          description: 'Returns one Agency-owned notification Subscription without its write-only callback bearer token.',
          parameters: [version, { $ref: '#/components/parameters/SubscriptionId' }],
          responses: { 200: { description: 'Notification Subscription.', headers: { ETag: { $ref: '#/components/headers/ETag' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Subscription' } } } }, ...errors },
        },
        put: {
          operationId: 'replaceSubscription', tags: ['subscription'], 'x-cli-name': 'replace', security: serviceSecurity(scopes.subscriptionsManage),
          description: 'Creates or completely replaces a client-identified Subscription. Creation requires If-None-Match: *. Replacement requires the current If-Match validator. Every request supplies the complete delivery configuration and callback bearer token; the token is encrypted at rest and never returned.',
          parameters: [version, { $ref: '#/components/parameters/SubscriptionId' },
            { name: 'If-Match', in: 'header', required: false, description: 'Required when replacing an existing Subscription.', schema: { type: 'string' } },
            { name: 'If-None-Match', in: 'header', required: false, description: 'Must be * when creating a Subscription.', schema: { type: 'string', const: '*' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplaceSubscription' } } } },
          responses: {
            200: { description: 'Subscription replaced.', headers: { ETag: { $ref: '#/components/headers/ETag' }, Location: { $ref: '#/components/headers/Location' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Subscription' } } } },
            201: { description: 'Subscription created.', headers: { ETag: { $ref: '#/components/headers/ETag' }, Location: { $ref: '#/components/headers/Location' }, ...protectedResponseHeaders }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Subscription' } } } },
            ...errors,
          },
        },
        delete: {
          operationId: 'deleteSubscription', tags: ['subscription'], 'x-cli-name': 'delete', security: serviceSecurity(scopes.subscriptionsManage),
          description: 'Deletes a Subscription and its pending notification events. Requires the current If-Match validator.',
          parameters: [version, { $ref: '#/components/parameters/SubscriptionId' }, { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } }],
          responses: { 204: { description: 'Subscription deleted.', headers: protectedResponseHeaders }, ...errors },
        },
      },
    },
    components: {
      securitySchemes: {
        RealmrootOAuth: {
          type: 'oauth2', flows: { authorizationCode: { authorizationUrl: `${issuer}/oauth2/authorize`, tokenUrl: `${issuer}/oauth2/token`, scopes: scopeCatalog } },
          'x-dpop-required': true,
          description: 'Realmroot OAuth access token. Agent requests require a DPoP-bound token and a fresh per-request proof.',
        },
        RealmrootServiceOAuth: {
          type: 'oauth2', flows: { clientCredentials: { tokenUrl: `${issuer}/oauth2/token`, scopes: scopeCatalog } },
          description: 'Realmroot Bearer access token for machine Applications. Agency subscription operations remain restricted to the configured Agency client; messages:create permits an authorized Application to send service Messages.',
        },
      },
      parameters: {
        MessageId: { name: 'messageId', in: 'path', required: true, schema: { type: 'string', pattern: '^msg_[0-9a-f]{32}$' } },
        SubscriptionId: { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string', pattern: '^sub_[0-9a-f]{32}$' } },
      },
      headers: {
        RequestId: { description: 'Server-generated request correlation identifier.', schema: { type: 'string' } },
        ApiVersion: { schema: { type: 'string', const: API_VERSION } },
        CacheControl: { schema: { type: 'string', const: 'private, no-store, no-transform' } },
        ETag: { schema: { type: 'string' } },
        IdempotencyReplayed: { schema: { type: 'string', enum: ['true', 'false'] } },
        Link: { schema: { type: 'string' } },
        Location: { schema: { type: 'string', format: 'uri' } },
      },
      schemas: {
        Problem: problem,
        Pagination: { type: 'object', required: ['pageSize'], properties: { pageSize: { type: 'integer' }, nextPageToken: { type: 'string' } } },
        Mailbox: { type: 'object', required: ['id', 'agent', 'addresses', 'createdAt', 'updatedAt', 'links'], properties: { id: { type: 'string' }, agent: { type: 'object' }, addresses: { type: 'object' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, links: { type: 'object' } } },
        Message: message,
        CreateMessage: { type: 'object', additionalProperties: false, required: ['recipients', 'content'], properties: { recipients: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^agent:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$' } }, subject: { type: ['string', 'null'] }, content: { type: 'object', properties: { text: { type: 'string' }, html: { type: 'string' } } }, inReplyTo: { type: ['string', 'null'], pattern: '^msg_[0-9a-f]{32}$' }, routingKey: { type: 'string', minLength: 1, maxLength: 512 } } },
        Subscription: {
          type: 'object',
          required: ['id', 'agentId', 'events', 'delivery', 'createdAt', 'updatedAt', 'links'],
          properties: {
            id: { type: 'string', pattern: '^sub_[0-9a-f]{32}$' },
            agentId: { type: 'string', format: 'uuid' },
            events: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: ['message.created'] } },
            delivery: { type: 'object', required: ['url', 'authorization'], properties: { url: { type: 'string', format: 'uri', pattern: '^https://' }, authorization: { type: 'object', required: ['scheme'], properties: { scheme: { type: 'string', const: 'bearer' } } } } },
            createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
            links: { type: 'object', required: ['self'], properties: { self: { type: 'string', format: 'uri' } } },
          },
        },
        ReplaceSubscription: {
          type: 'object', additionalProperties: false, required: ['agentId', 'events', 'delivery'],
          properties: {
            agentId: { type: 'string', format: 'uuid' },
            events: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', enum: ['message.created'] } },
            delivery: { type: 'object', additionalProperties: false, required: ['url', 'authorization'], properties: { url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 }, authorization: { type: 'object', additionalProperties: false, required: ['scheme', 'token'], properties: { scheme: { type: 'string', const: 'bearer' }, token: { type: 'string', minLength: 32, maxLength: 4096, writeOnly: true } } } } },
          },
        },
      },
    },
  }
}
