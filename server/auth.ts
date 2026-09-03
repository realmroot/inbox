import { operationPolicy, type OperationId } from './policy'
import { forbidden, unauthorized } from './errors'
import { agentSubjectSchema } from '../shared/identity'
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWTPayload,
} from 'jose'

export interface AgentPrincipal {
  kind: 'agent'
  owner: { issuer: string; subject: string }
  agent: { issuer: string; subject: string }
  scopes: readonly string[]
}

export interface ServicePrincipal {
  kind: 'service'
  issuer: string
  subject: string
  clientId: string
  scopes: readonly string[]
}

export type Principal = AgentPrincipal | ServicePrincipal

const realmrootCliClientId = 'realmroot-cli'

export type Authenticator = (
  request: Request,
  env: Cloudflare.Env,
) => Promise<Principal>

export const authenticatePrincipal: Authenticator = async (request, env) => {
  const authorization = request.headers.get('authorization') ?? ''
  if (/^DPoP\s+/i.test(authorization)) return authenticateAgent(request, env)
  if (/^Bearer\s+/i.test(authorization)) return authenticateService(request, env)
  throw unauthorized('Realmroot DPoP or Bearer access token is required.', {
    'WWW-Authenticate': 'DPoP, Bearer',
  })
}

export const authenticateAgent = async (request: Request, env: Cloudflare.Env): Promise<AgentPrincipal> => {
  const token = authorizationToken(request)
  const { payload, protectedHeader } = await jwtVerify(token, await keySet(env), {
    issuer: env.OIDC_ISSUER,
    audience: `${env.APP_ORIGIN}/api`,
    algorithms: ['EdDSA', 'ES256', 'RS256'],
  }).catch(() => {
    throw agentUnauthorized('Agent access token is invalid.')
  })
  if (protectedHeader.typ !== 'at+jwt') throw agentUnauthorized('Agent access token type is invalid.')
  if (typeof payload.sub !== 'string') throw agentUnauthorized('Agent access token has no controlling subject.')

  const confirmation = payload.cnf as { jkt?: unknown } | undefined
  if (typeof confirmation?.jkt !== 'string') throw agentUnauthorized('Agent access token is not DPoP-bound.')
  await verifyDpopProof(request, token, confirmation.jkt, payload.iss!, env.DB)

  const agent = resolveAgent(payload, env.OIDC_ISSUER)
  return {
    kind: 'agent',
    owner: { issuer: env.OIDC_ISSUER, subject: payload.sub },
    agent,
    scopes: tokenScopes(payload),
  }
}

export const authenticateService = async (request: Request, env: Cloudflare.Env): Promise<ServicePrincipal> => {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]) throw serviceUnauthorized('Realmroot Bearer access token is required.')
  const { payload, protectedHeader } = await jwtVerify(match[1], await keySet(env), {
    issuer: env.OIDC_ISSUER,
    audience: `${env.APP_ORIGIN}/api`,
    algorithms: ['EdDSA', 'ES256', 'RS256'],
  }).catch(() => {
    throw serviceUnauthorized('Service access token is invalid.')
  })
  if (protectedHeader.typ !== 'at+jwt') throw serviceUnauthorized('Service access token type is invalid.')
  if (typeof payload.sub !== 'string' || typeof payload.client_id !== 'string' || payload.act !== undefined || payload.cnf !== undefined) {
    throw serviceUnauthorized('Service identity is invalid.')
  }
  return {
    kind: 'service',
    issuer: env.OIDC_ISSUER,
    subject: payload.sub,
    clientId: payload.client_id,
    scopes: tokenScopes(payload),
  }
}

export function authorizePrincipal(principal: Principal, env: Cloudflare.Env, operationId: OperationId) {
  const policy = operationPolicy(operationId)
  if (!policy.principalKinds.includes(principal.kind)) {
    throw forbidden(`A ${principal.kind} principal cannot perform ${operationId}.`)
  }
  if (!principal.scopes.includes(policy.scope)) {
    throw principal.kind === 'agent' ? insufficientScope(policy.scope) : serviceInsufficientScope(policy.scope)
  }
  if (policy.serviceClient === 'agency') {
    if (!env.AGENCY_CLIENT_ID) throw new Error('AGENCY_CLIENT_ID is required.')
    if (principal.kind !== 'service' || principal.clientId !== env.AGENCY_CLIENT_ID) {
      throw forbidden('The Agency service identity is required.')
    }
  }
}

function tokenScopes(payload: JWTPayload) {
  return typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : []
}

function authorizationToken(request: Request) {
  const match = request.headers.get('authorization')?.match(/^DPoP\s+(.+)$/i)
  if (!match?.[1]) throw agentUnauthorized('DPoP access token is required.')
  return match[1]
}

const remoteKeySets = new Map<string, Promise<ReturnType<typeof createRemoteJWKSet>>>()

async function keySet(env: Cloudflare.Env) {
  if (env.OIDC_JWKS) return createLocalJWKSet(JSON.parse(env.OIDC_JWKS))
  let pending = remoteKeySets.get(env.OIDC_ISSUER)
  if (!pending) {
    pending = discoverKeySet(env.OIDC_ISSUER)
    remoteKeySets.set(env.OIDC_ISSUER, pending)
    pending.catch(() => remoteKeySets.delete(env.OIDC_ISSUER))
  }
  return pending
}

async function discoverKeySet(issuer: string) {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw agentUnauthorized('OIDC discovery failed.')
  const metadata = await response.json<{ issuer?: unknown; jwks_uri?: unknown }>()
  if (metadata.issuer !== issuer || typeof metadata.jwks_uri !== 'string') throw agentUnauthorized('OIDC discovery metadata is invalid.')
  return createRemoteJWKSet(new URL(metadata.jwks_uri))
}

export function resolveAgent(payload: JWTPayload, issuer: string) {
  const actor = payload.act as { iss?: unknown; sub?: unknown } | undefined
  const subject = agentSubjectSchema.safeParse(actor?.sub)
  if (payload.client_id !== realmrootCliClientId || actor?.iss !== issuer || !subject.success) {
    throw agentUnauthorized('A delegated Realmroot Agent access token is required.')
  }
  return { issuer, subject: subject.data }
}

async function verifyDpopProof(request: Request, accessToken: string, thumbprint: string, issuer: string, db: D1Database) {
  const compact = request.headers.get('dpop')
  if (!compact) throw dpopUnauthorized('DPoP proof is required.')
  let header: ReturnType<typeof decodeProtectedHeader>
  try { header = decodeProtectedHeader(compact) } catch { throw dpopUnauthorized('DPoP proof is malformed.') }
  if (header.typ !== 'dpop+jwt' || !header.jwk || (header.alg !== 'ES256' && header.alg !== 'EdDSA') || 'd' in header.jwk) {
    throw dpopUnauthorized('DPoP proof header is invalid.')
  }
  const keyThumbprint = await calculateJwkThumbprint(header.jwk)
  if (keyThumbprint !== thumbprint) throw dpopUnauthorized('DPoP key does not match the access token.')
  const publicKey = await importJWK(header.jwk, header.alg)
  const { payload } = await jwtVerify(compact, publicKey, { algorithms: [header.alg] }).catch(() => {
    throw dpopUnauthorized('DPoP proof signature is invalid.')
  })
  const now = Math.floor(Date.now() / 1000)
  const target = new URL(request.url)
  target.search = ''
  target.hash = ''
  if (payload.htm !== request.method || payload.htu !== target.href) throw dpopUnauthorized('DPoP proof target is invalid.')
  if (typeof payload.iat !== 'number' || Math.abs(now - payload.iat) > 60) throw dpopUnauthorized('DPoP proof timestamp is outside the allowed window.')
  if (typeof payload.jti !== 'string') throw dpopUnauthorized('DPoP proof has no identifier.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken))
  if (payload.ath !== base64url(new Uint8Array(digest))) throw dpopUnauthorized('DPoP access token hash is invalid.')

  const expiresAt = new Date((now + 120) * 1000).toISOString()
  await db.prepare('DELETE FROM dpop_replay WHERE expires_at <= ?').bind(new Date().toISOString()).run()
  const inserted = await db.prepare('INSERT OR IGNORE INTO dpop_replay (issuer, jti, expires_at) VALUES (?, ?, ?)')
    .bind(`${issuer}#${keyThumbprint}`, payload.jti, expiresAt).run()
  if (inserted.meta.changes !== 1) throw dpopUnauthorized('DPoP proof was already used.')
}

function agentUnauthorized(message: string) {
  return unauthorized(message, { 'WWW-Authenticate': `DPoP error="invalid_token", error_description="${message}"` })
}

function insufficientScope(scope: string) {
  return forbidden(`The ${scope} scope is required.`, { 'WWW-Authenticate': `DPoP error="insufficient_scope", scope="${scope}"` })
}

function dpopUnauthorized(message: string) {
  return unauthorized(message, { 'WWW-Authenticate': `DPoP error="invalid_dpop_proof", error_description="${message}"` })
}

function serviceUnauthorized(message: string) {
  return unauthorized(message, { 'WWW-Authenticate': `Bearer error="invalid_token", error_description="${message}"` })
}

function serviceInsufficientScope(scope: string) {
  return forbidden(`The ${scope} scope is required.`, { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"` })
}

function base64url(bytes: Uint8Array) {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
