import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        serviceBindings: {
          REALMROOT: (request) => {
            const subject = new URL(request.url).pathname.split('/').at(-1)
            const username = subject === 'agt_wired'
              ? 'wired-agent'
              : subject === 'agt_alpha'
                ? 'alpha-agent'
                : null
            return username
              ? Response.json({
                  type: 'agent', issuer: 'https://id.test/api/auth', subject,
                  username,
                })
              : new Response(null, { status: 404 })
          },
        },
        bindings: {
          APP_ORIGIN: 'https://inbox.test',
          OIDC_ISSUER: 'https://id.test/api/auth',
          EMAIL_DOMAIN: 'agents.test',
          OIDC_JWKS: '{"keys":[]}',
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
        },
      },
    })),
  ],
  test: { setupFiles: ['./tests/apply-migrations.ts'] },
})
