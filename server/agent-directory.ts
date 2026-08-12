import { z } from 'zod'
import { agentSubjectSchema } from '../shared/identity'

export interface AgentIdentity {
  issuer: string
  subject: string
  username: string
}

export interface AgentDirectory {
  find(issuer: string, subject: string): Promise<AgentIdentity | null>
  findByUsername(issuer: string, username: string): Promise<AgentIdentity | null>
}

const agentUsername = /^[a-z0-9_.-]{3,64}$/
const publicAgentSchema = z.object({
  type: z.literal('agent'),
  issuer: z.url(),
  subject: agentSubjectSchema,
  username: z.string().regex(agentUsername),
})

export function createRealmrootAgentDirectory(realmroot: Pick<Fetcher, 'fetch'>): AgentDirectory {
  return {
    async find(issuer, subject) {
      if (!agentSubjectSchema.safeParse(subject).success) return null
      const profile = await findProfile(realmroot, issuer, subject)
      if (!profile) return null
      if (profile.issuer !== issuer || profile.subject !== subject) {
        throw new Error('Realmroot Agent directory returned a mismatched identity.')
      }
      return { issuer: profile.issuer, subject: profile.subject, username: profile.username }
    },
    async findByUsername(issuer, username) {
      if (!agentUsername.test(username)) return null
      const profile = await findProfile(realmroot, issuer, username)
      if (!profile) return null
      if (profile.issuer !== issuer || profile.username !== username) {
        throw new Error('Realmroot Agent directory returned a mismatched identity.')
      }
      return { issuer: profile.issuer, subject: profile.subject, username: profile.username }
    },
  }
}

async function findProfile(realmroot: Pick<Fetcher, 'fetch'>, issuer: string, identifier: string) {
  const url = new URL(`../public/agents/${encodeURIComponent(identifier)}?view=summary`, `${issuer.replace(/\/$/, '')}/`)
  const response = await realmroot.fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Realmroot Agent directory returned HTTP ${response.status}.`)
  return publicAgentSchema.parse(await response.json())
}

export function stableAddressUsername(address: string, emailDomain: string) {
  const normalized = address.toLowerCase()
  const suffix = `@${emailDomain.toLowerCase()}`
  if (!normalized.endsWith(suffix)) return null
  const username = normalized.slice(0, -suffix.length)
  return agentUsername.test(username) ? username : null
}
