import { describe, expect, it } from 'vitest'
import { resolveAgent } from '../server/auth'

const issuer = 'https://id.test/api/auth'
const subject = '019feeeb-6504-74ec-bfdc-da5259f73fc0'

describe('delegated Agent identity', () => {
  it('accepts only a UUIDv7 Agent actor subject', () => {
    expect(resolveAgent({ act: { iss: issuer, sub: subject, sub_profile: 'ai_agent' } }, issuer)).toEqual({
      issuer,
      subject,
    })

    expect(() => resolveAgent({ act: { iss: issuer, sub: 'agt_legacy', sub_profile: 'ai_agent' } }, issuer)).toThrow(
      'A delegated Realmroot Agent access token is required.',
    )
    expect(() => resolveAgent({ act: { iss: issuer, sub: '550e8400-e29b-41d4-a716-446655440000', sub_profile: 'ai_agent' } }, issuer)).toThrow(
      'A delegated Realmroot Agent access token is required.',
    )
  })
})
