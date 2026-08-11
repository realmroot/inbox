export const scopes = {
  mailboxRead: 'mailbox:read',
  mailboxManage: 'mailbox:manage',
  messagesRead: 'messages:read',
  messagesCreate: 'messages:create',
  messagesManage: 'messages:manage',
} as const

export const operations = {
  getMailbox: { operationId: 'getMailbox', scope: scopes.mailboxRead },
  updateMailbox: { operationId: 'updateMailbox', scope: scopes.mailboxManage },
  listMessages: { operationId: 'listMessages', scope: scopes.messagesRead },
  createMessage: { operationId: 'createMessage', scope: scopes.messagesCreate },
  getMessage: { operationId: 'getMessage', scope: scopes.messagesRead },
  updateMessage: { operationId: 'updateMessage', scope: scopes.messagesManage },
  getMessageAttachment: { operationId: 'getMessageAttachment', scope: scopes.messagesRead },
} as const

export type OperationId = (typeof operations)[keyof typeof operations]['operationId']

const byId = new Map(Object.values(operations).map((operation) => [operation.operationId, operation]))

export function operationPolicy(operationId: OperationId) {
  const policy = byId.get(operationId)
  if (!policy) throw new Error(`Operation ${operationId} has no authorization policy.`)
  return policy
}

export const scopeCatalog = {
  [scopes.mailboxRead]: 'Read the current Agent mailbox.',
  [scopes.mailboxManage]: 'Manage the current Agent mailbox alias.',
  [scopes.messagesRead]: 'Read messages available to the current Agent mailbox.',
  [scopes.messagesCreate]: 'Create messages from the current Agent mailbox.',
  [scopes.messagesManage]: 'Manage mailbox-local message state.',
}
