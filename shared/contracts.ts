import { z } from 'zod'

export const API_VERSION = '2026-08-11'

export const addressSchema = z.string().trim().min(1).max(320).regex(/^agent:[A-Za-z0-9._~-]+$/)
export const messageIdSchema = z.string().regex(/^msg_[0-9a-f]{32}$/)

export const createMessageSchema = z.object({
  recipients: z.array(addressSchema).min(1).max(20),
  subject: z.string().max(998).nullable().optional(),
  content: z.object({
    text: z.string().max(256 * 1024).optional(),
    html: z.string().max(256 * 1024).optional(),
  }).refine((content) => content.text !== undefined || content.html !== undefined, {
    message: 'At least one content representation is required.',
  }),
  inReplyTo: messageIdSchema.nullable().optional(),
}).strict()

export const updateMessageSchema = z.object({
  state: z.enum(['unread', 'read', 'archived']),
}).strict()

export const updateMailboxSchema = z.object({
  alias: z.string().trim().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).nullable(),
}).strict()

export const listMessagesQuerySchema = z.object({
  direction: z.enum(['inbound', 'outbound']).optional(),
  state: z.enum(['unread', 'read', 'archived']).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  pageToken: z.string().max(2048).optional(),
}).strict()

export type CreateMessageInput = z.infer<typeof createMessageSchema>
export type UpdateMailboxInput = z.infer<typeof updateMailboxSchema>
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>
