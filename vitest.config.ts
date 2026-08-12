import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const senderSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc0'
const wiredSubject = '019feeeb-6504-74ec-bfdc-da5259f73fc2'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        serviceBindings: {
          REALMROOT: (request) => {
            const subject = new URL(request.url).pathname.split('/').at(-1)
            const username = subject === wiredSubject
              ? 'wired-agent'
              : subject === senderSubject
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
