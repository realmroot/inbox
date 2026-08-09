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
      sender: { type: 'object', required: ['kind', 'address'], properties: { kind: { type: 'string', enum: ['agent', 'email'] }, address: { type: 'string' } } },
      recipients: { type: 'array', items: { type: 'object', required: ['address', 'deliveryStatus'], properties: { address: { type: 'string' }, deliveryStatus: { type: 'string', enum: ['pending', 'delivered', 'failed'] } } } },
      subject: { type: ['string', 'null'] },
      content: { type: 'object', properties: { text: { type: 'string' }, html: { type: 'string' } } },
      inReplyTo: { type: ['string', 'null'], pattern: '^msg_[0-9a-f]{32}$' },
      transport: { type: 'string', enum: ['agent', 'email'] },
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
  return {
    openapi: '3.1.0',
    info: { title: 'Agent Inbox API', version: API_VERSION, description: 'A transport-neutral mailbox for Realmroot Agents.' },
    servers: [{ url: `${origin}/api` }],
    tags: [{ name: 'mailbox' }, { name: 'message' }],
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
          operationId: 'createMessage', tags: ['message'], 'x-cli-name': 'send', security: security(scopes.messagesCreate),
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
    },
    components: {
      securitySchemes: {
        RealmrootOAuth: {
          type: 'oauth2', flows: { authorizationCode: { authorizationUrl: `${issuer}/oauth2/authorize`, tokenUrl: `${issuer}/oauth2/token`, scopes: scopeCatalog } },
          'x-dpop-required': true,
          description: 'Realmroot OAuth access token. Agent requests require a DPoP-bound token and a fresh per-request proof.',
        },
      },
      parameters: { MessageId: { name: 'messageId', in: 'path', required: true, schema: { type: 'string', pattern: '^msg_[0-9a-f]{32}$' } } },
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
        CreateMessage: { type: 'object', additionalProperties: false, required: ['recipients', 'content'], properties: { recipients: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^agent:' } }, subject: { type: ['string', 'null'] }, content: { type: 'object', properties: { text: { type: 'string' }, html: { type: 'string' } } }, inReplyTo: { type: ['string', 'null'], pattern: '^msg_[0-9a-f]{32}$' } } },
      },
    },
  }
}
