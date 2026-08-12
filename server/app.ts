import { Hono, type Context, type Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { authenticateAgent, type AgentPrincipal, type Authenticator } from './auth'
import { createRealmrootAgentDirectory, type AgentDirectory } from './agent-directory'
import { ApiError, badRequest } from './errors'
import { openApi } from './openapi'
import { metadataPath, metadataUrl, protectedResourceMetadata } from './protected-resource'
import { operations, type OperationId } from './policy'
import {
  createMessage,
  getAttachment,
  getMessage,
  getOrCreateMailbox,
  listMessages,
  mailboxEtag,
  mailboxRepresentation,
  messageEtag,
  updateMailbox,
  updateMessage,
} from './repository'
import {
  API_VERSION,
  createMessageSchema,
  listMessagesQuerySchema,
  updateMailboxSchema,
  updateMessageSchema,
} from '../shared/contracts'

type AppEnv = {
  Bindings: Cloudflare.Env
  Variables: { requestId: string; principal: AgentPrincipal }
}

export function createApp(
  authenticate: Authenticator = authenticateAgent,
  agentDirectory: (env: Cloudflare.Env) => AgentDirectory = (env) => createRealmrootAgentDirectory(env.REALMROOT),
) {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('Request-Id', requestId)
    const started = Date.now()
    await next()
    console.log(JSON.stringify({
      event: 'http_request_completed', requestId, method: c.req.method,
      path: new URL(c.req.url).pathname, status: c.res.status, durationMs: Date.now() - started,
    }))
  })
  app.use('*', secureHeaders())
  app.use('/api/*', cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'DPoP', 'Idempotency-Key', 'If-Match', 'API-Version', 'traceparent', 'tracestate'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    exposeHeaders: ['API-Version', 'ETag', 'Idempotency-Replayed', 'Link', 'Location', 'Request-Id', 'WWW-Authenticate'],
    maxAge: 86400,
  }))
  app.use('/api/*', bodyLimit({ maxSize: 600 * 1024, onError: () => { throw badRequest('Request body exceeds 600 KiB.') } }))

  app.get(metadataPath, (c) => {
    c.header('Access-Control-Allow-Origin', '*')
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(protectedResourceMetadata(c.env))
  })
  app.get('/healthz', (c) => c.json({ status: 'ok' }))
  app.get('/readyz', async (c) => {
    await c.env.DB.prepare('SELECT 1').first()
    return c.json({ status: 'ready' })
  })
  app.get('/api', (c) => {
    c.header('Link', `<${c.env.APP_ORIGIN}/api/openapi.json>; rel="service-desc"; type="application/openapi+json"`)
    return c.json({ name: 'Agent Inbox API', resource: `${c.env.APP_ORIGIN}/api`, openapi: `${c.env.APP_ORIGIN}/api/openapi.json` })
  })
  app.get('/api/openapi.json', (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    return c.json(openApi(c.env.APP_ORIGIN, c.env.OIDC_ISSUER))
  })

  app.use('/api/mailbox', versionMiddleware)
  app.use('/api/messages', versionMiddleware)
  app.use('/api/messages/*', versionMiddleware)

  app.get('/api/mailbox', authorize(authenticate, operations.getMailbox.operationId), async (c) => {
    const mailbox = await currentMailbox(c, agentDirectory(c.env))
    c.header('ETag', mailboxEtag(mailbox))
    return c.json(mailboxRepresentation(mailbox, c.env.APP_ORIGIN))
  })
  app.patch('/api/mailbox', authorize(authenticate, operations.updateMailbox.operationId), async (c) => {
    const input = await parseJson(c, updateMailboxSchema)
    const mailbox = await updateMailbox(
      c.env.DB,
      await currentMailbox(c, agentDirectory(c.env)),
      input,
      c.req.header('If-Match'),
      c.env.EMAIL_DOMAIN,
    )
    c.header('ETag', mailboxEtag(mailbox))
    return c.json(mailboxRepresentation(mailbox, c.env.APP_ORIGIN))
  })
  app.get('/api/messages', authorize(authenticate, operations.listMessages.operationId), async (c) => {
    const parsed = listMessagesQuerySchema.safeParse(c.req.query())
    if (!parsed.success) throw badRequest(parsed.error.issues.map((issue) => issue.message).join('; '))
    const mailbox = await currentMailbox(c, agentDirectory(c.env))
    const result = await listMessages(c.env.DB, mailbox.id, c.env.APP_ORIGIN, parsed.data)
    if (result.pagination.nextPageToken) {
      const next = new URL(c.req.url)
      next.searchParams.set('pageToken', result.pagination.nextPageToken)
      c.header('Link', `<${next.href}>; rel="next"`)
    }
    return c.json(result)
  })
  app.post('/api/messages', authorize(authenticate, operations.createMessage.operationId), async (c) => {
    const key = c.req.header('Idempotency-Key')
    if (!key || key.length < 8 || key.length > 200) throw badRequest('Idempotency-Key must contain 8 to 200 characters.')
    const input = await parseJson(c, createMessageSchema)
    const mailbox = await currentMailbox(c, agentDirectory(c.env))
    const result = await createMessage(
      c.env.DB,
      mailbox,
      c.get('principal'),
      c.env.APP_ORIGIN,
      input,
      key,
      agentDirectory(c.env),
      c.env.EMAIL_DOMAIN,
    )
    c.header('Location', `${c.env.APP_ORIGIN}/api/messages/${result.message.id}`)
    c.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
    return c.json(result.message, result.replayed ? 200 : 201)
  })
  app.get('/api/messages/:messageId', authorize(authenticate, operations.getMessage.operationId), async (c) => {
    const mailbox = await currentMailbox(c, agentDirectory(c.env))
    const message = await getMessage(c.env.DB, mailbox.id, requiredParam(c, 'messageId'), c.env.APP_ORIGIN)
    const version = message.direction === 'outbound' ? null : await recipientVersion(c.env.DB, mailbox.id, message.id)
    const etag = messageEtag(version)
    if (etag) c.header('ETag', etag)
    return c.json(message)
  })
  app.patch('/api/messages/:messageId', authorize(authenticate, operations.updateMessage.operationId), async (c) => {
    const input = await parseJson(c, updateMessageSchema)
    const mailbox = await currentMailbox(c, agentDirectory(c.env))
    const message = await updateMessage(c.env.DB, mailbox.id, requiredParam(c, 'messageId'), input, c.req.header('If-Match'), c.env.APP_ORIGIN)
    const version = await recipientVersion(c.env.DB, mailbox.id, message.id)
    c.header('ETag', messageEtag(version)!)
    return c.json(message)
  })
  app.get('/api/messages/:messageId/attachments/:attachmentId', authorize(authenticate, operations.getMessageAttachment.operationId), async (c) => {
    const mailbox = await currentMailbox(c, agentDirectory(c.env))
    const attachment = await getAttachment(c.env.DB, mailbox.id, requiredParam(c, 'messageId'), requiredParam(c, 'attachmentId'))
    const object = await c.env.ATTACHMENTS.get(attachment.object_key)
    if (!object?.body) throw new ApiError(404, 'https://inbox.realmroot.dev/problems/not-found', 'Not found', 'Attachment data not found.')
    const headers = new Headers({ 'Content-Type': attachment.media_type, 'Content-Length': String(attachment.size), ETag: object.httpEtag })
    if (attachment.filename) headers.set('Content-Disposition', `${attachment.disposition === 'inline' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`)
    return new Response(object.body, { headers })
  })

  app.notFound((c) => problem(c, new ApiError(404, 'https://inbox.realmroot.dev/problems/not-found', 'Not found', 'Resource not found.')))
  app.onError((error, c) => {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(500, 'https://inbox.realmroot.dev/problems/internal', 'Internal error', 'The request failed.')
    if (!(error instanceof ApiError)) console.error(JSON.stringify({ event: 'http_request_failed', requestId: c.get('requestId'), error: error instanceof Error ? error.message : String(error) }))
    return problem(c, apiError)
  })
  return app
}

function authorize(authenticate: Authenticator, operationId: OperationId) {
  return async (c: Context<AppEnv>, next: Next) => {
    c.set('principal', await authenticate(c.req.raw, c.env, operationId))
    await next()
  }
}

async function versionMiddleware(c: Context<AppEnv>, next: Next) {
  const version = c.req.header('API-Version')
  if (version !== API_VERSION) throw badRequest(`API-Version must be ${API_VERSION}.`)
  c.header('API-Version', API_VERSION)
  c.header('Cache-Control', 'private, no-store, no-transform')
  c.header('Vary', 'API-Version')
  await next()
}

async function currentMailbox(c: Context<AppEnv>, directory: AgentDirectory) {
  return getOrCreateMailbox(c.env.DB, c.get('principal'), directory, c.env.EMAIL_DOMAIN)
}

async function parseJson<T>(c: Context<AppEnv>, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }) {
  let value: unknown
  try { value = await c.req.json() } catch { throw badRequest('Request body must be valid JSON.') }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw badRequest(parsed.error.issues.map((issue) => issue.message).join('; '))
  return parsed.data
}

async function recipientVersion(db: D1Database, mailboxId: string, messageId: string) {
  const row = await db.prepare('SELECT version FROM message_recipient WHERE mailbox_id = ? AND message_id = ?')
    .bind(mailboxId, messageId).first<{ version: number }>()
  return row?.version ?? null
}

function requiredParam(c: Context<AppEnv>, name: string) {
  const value = c.req.param(name)
  if (!value) throw badRequest(`${name} is required.`)
  return value
}

function problem(c: Context<AppEnv>, error: ApiError) {
  if (error.headers) for (const [name, value] of new Headers(error.headers)) c.header(name, value)
  if ((error.status === 401 || error.status === 403) && !c.res.headers.get('WWW-Authenticate')?.includes('resource_metadata=')) {
    const current = c.res.headers.get('WWW-Authenticate')
    c.header('WWW-Authenticate', `${current ? `${current}, ` : 'DPoP '}resource_metadata="${metadataUrl(c.env)}"`)
  }
  return c.json({
    type: error.type,
    title: error.title,
    status: error.status,
    detail: error.message,
    instance: new URL(c.req.url).pathname,
    requestId: c.get('requestId'),
  }, error.status, { 'Content-Type': 'application/problem+json' })
}
