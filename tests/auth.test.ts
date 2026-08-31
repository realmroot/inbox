import { describe, expect, it } from 'vitest'
import { resolveAgencyService, resolveAgent } from '../server/auth'

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
