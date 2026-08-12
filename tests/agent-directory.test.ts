import { describe, expect, it, vi } from 'vitest'
import { createRealmrootAgentDirectory, stableAddressUsername } from '../server/agent-directory'

const targetUsername = 'target-agent'
const targetSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc0'
const otherSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc1'

describe('Realmroot Agent directory', () => {
  it('resolves an exact public Agent identity through the Realmroot service binding', async () => {
    const fetch = vi.fn(async () => Response.json({
      type: 'agent',
      issuer: 'https://id.test/api/auth',
      subject: targetSubject,
      username: targetUsername,
    }))
    const directory = createRealmrootAgentDirectory({ fetch })

    await expect(directory.find('https://id.test/api/auth', targetSubject)).resolves.toEqual({
      issuer: 'https://id.test/api/auth',
      subject: targetSubject,
      username: targetUsername,
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://id.test/api/public/agents/${targetSubject}?view=summary`),
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  it('resolves an exact public Agent identity by immutable username', async () => {
    const fetch = vi.fn(async () => Response.json({
      type: 'agent', issuer: 'https://id.test/api/auth', subject: targetSubject, username: targetUsername,
    }))
    const directory = createRealmrootAgentDirectory({ fetch })

    await expect(directory.findByUsername('https://id.test/api/auth', targetUsername)).resolves.toEqual({
      issuer: 'https://id.test/api/auth', subject: targetSubject, username: targetUsername,
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://id.test/api/public/agents/${targetUsername}?view=summary`),
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  it('does not provision unknown or invalid Agent subjects', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    const directory = createRealmrootAgentDirectory({ fetch })

    await expect(directory.find('https://id.test/api/auth', otherSubject)).resolves.toBeNull()
    await expect(directory.find('https://id.test/api/auth', 'agt_missing')).resolves.toBeNull()
    await expect(directory.find('https://id.test/api/auth', '550e8400-e29b-41d4-a716-446655440000')).resolves.toBeNull()
    await expect(directory.find('https://id.test/api/auth', 'not-an-agent')).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Realmroot returns a different identity', async () => {
    const directory = createRealmrootAgentDirectory({
      fetch: async () => Response.json({
        type: 'agent',
        issuer: 'https://id.test/api/auth',
        subject: otherSubject,
        username: targetUsername,
      }),
    })

    await expect(directory.find('https://id.test/api/auth', targetSubject)).rejects.toThrow(
      'Realmroot Agent directory returned a mismatched identity.',
    )
  })

  it('rejects a legacy Agent subject returned by Realmroot', async () => {
    const directory = createRealmrootAgentDirectory({
      fetch: async () => Response.json({
        type: 'agent', issuer: 'https://id.test/api/auth', subject: 'agt_legacy', username: targetUsername,
      }),
    })

    await expect(directory.findByUsername('https://id.test/api/auth', targetUsername)).rejects.toThrow()
  })
})

describe('stable Agent email addresses', () => {
  it('extracts only the canonical Realmroot Agent username for the configured domain', () => {
    expect(stableAddressUsername(`${targetUsername}@agents.test`, 'agents.test')).toBe(targetUsername)
    expect(stableAddressUsername('alias@agents.test', 'agents.test')).toBe('alias')
    expect(stableAddressUsername(`${targetUsername}@example.com`, 'agents.test')).toBeNull()
  })
})
