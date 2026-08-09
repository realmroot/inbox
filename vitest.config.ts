import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
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
