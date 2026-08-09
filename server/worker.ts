import { createApp } from './app'
import { deleteExpiredEmail, receiveEmail } from './email'

const app = createApp()

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  async email(message, env) {
    try {
      await receiveEmail(message, env)
    } catch (error) {
      console.error(JSON.stringify({ event: 'email_receive_failed', error: error instanceof Error ? error.message : String(error) }))
      throw error
    }
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(deleteExpiredEmail(env).then((deleted) => {
      console.log(JSON.stringify({ event: 'email_retention_completed', deletedMessages: deleted }))
    }).catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'email_retention_failed', error: error instanceof Error ? error.message : String(error) }))
      throw error
    }))
  },
} satisfies ExportedHandler<Cloudflare.Env>
