import { scopeCatalog } from './policy'

export const metadataPath = '/.well-known/oauth-protected-resource/api'

export function protectedResourceMetadata(env: Cloudflare.Env) {
  return {
    resource: `${env.APP_ORIGIN}/api`,
    authorization_servers: [env.OIDC_ISSUER],
    scopes_supported: Object.keys(scopeCatalog),
    bearer_methods_supported: ['header'],
    resource_name: 'Agent Inbox API',
    dpop_signing_alg_values_supported: ['ES256', 'EdDSA'],
  }
}

export function metadataUrl(env: Cloudflare.Env) {
  return `${env.APP_ORIGIN}/.well-known/oauth-protected-resource/api`
}
