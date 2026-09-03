import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { authenticateService, authorizePrincipal, resolveAgent, type AgentPrincipal, type ServicePrincipal } from '../server/auth'

const issuer = 'https://id.test/api/auth'
const subject = '019feeeb-6504-74ec-bfdc-da5259f73fc0'

describe('delegated Agent identity', () => {
  it('accepts only a UUIDv7 Agent actor subject', () => {
    expect(resolveAgent({ client_id: 'realmroot-cli', act: { iss: issuer, sub: subject } }, issuer)).toEqual({
      issuer,
      subject,
    })

    expect(() => resolveAgent({ client_id: 'realmroot-cli', act: { iss: issuer, sub: 'agt_legacy' } }, issuer)).toThrow(
      'A delegated Realmroot Agent access token is required.',
    )
    expect(() => resolveAgent({ client_id: 'realmroot-cli', act: { iss: issuer, sub: '550e8400-e29b-41d4-a716-446655440000' } }, issuer)).toThrow(
      'A delegated Realmroot Agent access token is required.',
    )
    expect(() =>
      resolveAgent({ client_id: 'another-client', act: { iss: issuer, sub: subject } }, issuer),
    ).toThrow('A delegated Realmroot Agent access token is required.')
  })
})

describe('Agency M2M service identity', () => {
  const serviceEnv = { OIDC_ISSUER: issuer, AGENCY_CLIENT_ID: 'realmroot-agency' } as unknown as Cloudflare.Env
  const principal: ServicePrincipal = {
    kind: 'service',
    issuer,
    subject: 'agency-service',
    clientId: 'realmroot-agency',
    scopes: ['subscriptions:manage'],
  }

  it('authorizes only the configured service client with the exact Subscription scope', () => {
    expect(() => authorizePrincipal(principal, serviceEnv, 'replaceSubscription')).not.toThrow()
    expect(() => authorizePrincipal({ ...principal, clientId: 'other-client' }, serviceEnv, 'replaceSubscription'))
      .toThrow('The Agency service identity is required.')
    expect(() => authorizePrincipal({ ...principal, scopes: ['messages:read'] }, serviceEnv, 'replaceSubscription'))
      .toThrow('The subscriptions:manage scope is required.')
  })
})

describe('principal authorization policy', () => {
  const runtimeEnv = { AGENCY_CLIENT_ID: 'realmroot-agency' } as unknown as Cloudflare.Env
  const agent: AgentPrincipal = {
    kind: 'agent',
    owner: { issuer, subject: 'controller' },
    agent: { issuer, subject },
    scopes: ['messages:create'],
  }
  const service: ServicePrincipal = {
    kind: 'service',
    issuer,
    subject: 'application-id',
    clientId: 'application-client-id',
    scopes: ['messages:create', 'messages:read'],
  }

  it('allows both principal kinds to create Messages but keeps mailbox reads Agent-only', () => {
    expect(() => authorizePrincipal(agent, runtimeEnv, 'createMessage')).not.toThrow()
    expect(() => authorizePrincipal(service, runtimeEnv, 'createMessage')).not.toThrow()
    expect(() => authorizePrincipal(service, runtimeEnv, 'listMessages'))
      .toThrow('A service principal cannot perform listMessages.')
  })
})

describe('Message service identity', () => {
  it('normalizes a machine Bearer token and rejects delegation or key binding', async () => {
    const keys = await generateKeyPair('ES256', { extractable: true })
    const jwk = await exportJWK(keys.publicKey)
    const keyId = 'message-service-test-key'
    jwk.kid = keyId
    const runtimeEnv = {
      OIDC_ISSUER: issuer,
      APP_ORIGIN: 'https://inbox.test',
      OIDC_JWKS: JSON.stringify({ keys: [jwk] }),
    } as unknown as Cloudflare.Env
    const token = async (claims: Record<string, unknown>) => new SignJWT({
      sub: 'agent-kanban-service',
      client_id: 'agent-kanban',
      scope: 'messages:create',
      ...claims,
    })
      .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience('https://inbox.test/api')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey)
    const authenticate = async (claims: Record<string, unknown>) => authenticateService(
      new Request('https://inbox.test/api/messages', { headers: { Authorization: `Bearer ${await token(claims)}` } }),
      runtimeEnv,
    )

    await expect(authenticate({})).resolves.toMatchObject({ kind: 'service', clientId: 'agent-kanban', scopes: ['messages:create'] })
    await expect(authenticate({ act: { iss: issuer, sub: subject } })).rejects.toThrow('Service identity is invalid.')
    await expect(authenticate({ cnf: { jkt: 'delegated-key' } })).rejects.toThrow('Service identity is invalid.')
    const insufficient = await authenticate({ scope: 'messages:read' })
    expect(() => authorizePrincipal(insufficient, runtimeEnv, 'createMessage')).toThrow('The messages:create scope is required.')
  })
})
