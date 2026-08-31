import { createApp } from './app'
import { deleteExpiredEmail, receiveEmail } from './email'
import { deleteRetainedNotificationEvents, deliverDueNotifications } from './notifications'

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
  scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const started = Date.now()
      try {
        const delivery = await deliverDueNotifications(env)
        const runRetention = new Date(controller.scheduledTime).getUTCMinutes() === 17
        const deletedMessages = runRetention ? await deleteExpiredEmail(env) : 0
        const deletedNotificationEvents = runRetention ? await deleteRetainedNotificationEvents(env.DB) : 0
        console.log(JSON.stringify({
          event: 'scheduled_work_completed',
          cron: controller.cron,
          delivery,
          deletedMessages,
          deletedNotificationEvents,
          durationMs: Date.now() - started,
        }))
      } catch (error) {
        console.error(JSON.stringify({
          event: 'scheduled_work_failed',
          cron: controller.cron,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        }))
        throw error
      }
    })())
  },
} satisfies ExportedHandler<Cloudflare.Env>
