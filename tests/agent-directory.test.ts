import { describe, expect, it, vi } from 'vitest'
import { createRealmrootAgentDirectory, stableAddressSubject } from '../server/agent-directory'

describe('Realmroot Agent directory', () => {
  it('resolves an exact public Agent identity through the Realmroot service binding', async () => {
    const fetch = vi.fn(async () => Response.json({
      type: 'agent',
      issuer: 'https://id.test/api/auth',
      subject: 'agt_target',
    }))
    const directory = createRealmrootAgentDirectory({ fetch })

    await expect(directory.find('https://id.test/api/auth', 'agt_target')).resolves.toEqual({
      issuer: 'https://id.test/api/auth',
      subject: 'agt_target',
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://id.test/api/public/agents/agt_target?view=summary'),
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })

  it('does not provision unknown or invalid Agent subjects', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    const directory = createRealmrootAgentDirectory({ fetch })

    await expect(directory.find('https://id.test/api/auth', 'agt_missing')).resolves.toBeNull()
    await expect(directory.find('https://id.test/api/auth', 'not-an-agent')).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Realmroot returns a different identity', async () => {
    const directory = createRealmrootAgentDirectory({
      fetch: async () => Response.json({
        type: 'agent',
        issuer: 'https://id.test/api/auth',
        subject: 'agt_other',
      }),
    })

    await expect(directory.find('https://id.test/api/auth', 'agt_target')).rejects.toThrow(
      'Realmroot Agent directory returned a mismatched identity.',
    )
  })
})

describe('stable Agent email addresses', () => {
  it('extracts only the canonical Realmroot Agent subject for the configured domain', () => {
    expect(stableAddressSubject('agt_target@agents.test', 'agents.test')).toBe('agt_target')
    expect(stableAddressSubject('alias@agents.test', 'agents.test')).toBeNull()
    expect(stableAddressSubject('agt_target@example.com', 'agents.test')).toBeNull()
  })
})
