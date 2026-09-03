import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { authenticateMessageService, resolveAgencyService, resolveAgent } from '../server/auth'

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
  const serviceEnv = { OIDC_ISSUER: issuer, AGENCY_CLIENT_ID: 'realmroot-agency' }

  it('accepts only the configured non-delegated service client with the exact Subscription scope', () => {
    expect(resolveAgencyService({
      sub: 'agency-service', client_id: 'realmroot-agency', scope: 'subscriptions:manage',
    }, serviceEnv, 'subscriptions:manage')).toMatchObject({
      issuer,
      subject: 'agency-service',
      clientId: 'realmroot-agency',
    })
    expect(() => resolveAgencyService({
      sub: 'agency-service', client_id: 'other-client', scope: 'subscriptions:manage',
    }, serviceEnv, 'subscriptions:manage')).toThrow('Agency service identity is invalid.')
    expect(() => resolveAgencyService({
      sub: 'agency-service', client_id: 'realmroot-agency', scope: 'subscriptions:manage', act: { sub: subject },
    }, serviceEnv, 'subscriptions:manage')).toThrow('Agency service identity is invalid.')
    expect(() => resolveAgencyService({
      sub: 'agency-service', client_id: 'realmroot-agency', scope: 'messages:read',
    }, serviceEnv, 'subscriptions:manage')).toThrow('The subscriptions:manage scope is required.')
  })
})

describe('Message service identity', () => {
  it('accepts a scoped machine Bearer token and rejects delegation, key binding, or insufficient scope', async () => {
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
    const authenticate = async (claims: Record<string, unknown>) => authenticateMessageService(
      new Request('https://inbox.test/api/messages', { headers: { Authorization: `Bearer ${await token(claims)}` } }),
      runtimeEnv,
      'createMessage',
    )

    await expect(authenticate({})).resolves.toMatchObject({ clientId: 'agent-kanban', scopes: ['messages:create'] })
    await expect(authenticate({ act: { iss: issuer, sub: subject } })).rejects.toThrow('Service identity is invalid.')
    await expect(authenticate({ cnf: { jkt: 'delegated-key' } })).rejects.toThrow('Service identity is invalid.')
    await expect(authenticate({ scope: 'messages:read' })).rejects.toThrow('The messages:create scope is required.')
  })
})
