import { z } from 'zod'

export interface AgentIdentity {
  issuer: string
  subject: string
}

export interface AgentDirectory {
  find(issuer: string, subject: string): Promise<AgentIdentity | null>
}

const agentSubject = /^agt_[a-zA-Z0-9_-]+$/
const publicAgentSchema = z.object({
  type: z.literal('agent'),
  issuer: z.url(),
  subject: z.string(),
})

export function createRealmrootAgentDirectory(realmroot: Pick<Fetcher, 'fetch'>): AgentDirectory {
  return {
    async find(issuer, subject) {
      if (!agentSubject.test(subject)) return null
      const url = new URL(`../public/agents/${encodeURIComponent(subject)}?view=summary`, `${issuer.replace(/\/$/, '')}/`)
      const response = await realmroot.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Realmroot Agent directory returned HTTP ${response.status}.`)
      const profile = publicAgentSchema.parse(await response.json())
      if (profile.issuer !== issuer || profile.subject !== subject) {
        throw new Error('Realmroot Agent directory returned a mismatched identity.')
      }
      return { issuer: profile.issuer, subject: profile.subject }
    },
  }
}

export function stableAddressSubject(address: string, emailDomain: string) {
  const normalized = address.toLowerCase()
  const suffix = `@${emailDomain.toLowerCase()}`
  if (!normalized.endsWith(suffix)) return null
  const subject = normalized.slice(0, -suffix.length)
  return agentSubject.test(subject) ? subject : null
}
