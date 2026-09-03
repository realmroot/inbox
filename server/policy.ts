export const scopes = {
  mailboxRead: 'mailbox:read',
  mailboxManage: 'mailbox:manage',
  messagesRead: 'messages:read',
  messagesCreate: 'messages:create',
  messagesManage: 'messages:manage',
  subscriptionsRead: 'subscriptions:read',
  subscriptionsManage: 'subscriptions:manage',
} as const

export type PrincipalKind = 'agent' | 'service'

interface OperationPolicy {
  operationId: string
  scope: string
  principalKinds: readonly PrincipalKind[]
  serviceClient?: 'agency'
}

export const operations = {
  getMailbox: { operationId: 'getMailbox', scope: scopes.mailboxRead, principalKinds: ['agent'] },
  updateMailbox: { operationId: 'updateMailbox', scope: scopes.mailboxManage, principalKinds: ['agent'] },
  listMessages: { operationId: 'listMessages', scope: scopes.messagesRead, principalKinds: ['agent'] },
  createMessage: { operationId: 'createMessage', scope: scopes.messagesCreate, principalKinds: ['agent', 'service'] },
  getMessage: { operationId: 'getMessage', scope: scopes.messagesRead, principalKinds: ['agent'] },
  updateMessage: { operationId: 'updateMessage', scope: scopes.messagesManage, principalKinds: ['agent'] },
  getMessageAttachment: { operationId: 'getMessageAttachment', scope: scopes.messagesRead, principalKinds: ['agent'] },
  listSubscriptions: { operationId: 'listSubscriptions', scope: scopes.subscriptionsRead, principalKinds: ['service'], serviceClient: 'agency' },
  getSubscription: { operationId: 'getSubscription', scope: scopes.subscriptionsRead, principalKinds: ['service'], serviceClient: 'agency' },
  replaceSubscription: { operationId: 'replaceSubscription', scope: scopes.subscriptionsManage, principalKinds: ['service'], serviceClient: 'agency' },
  deleteSubscription: { operationId: 'deleteSubscription', scope: scopes.subscriptionsManage, principalKinds: ['service'], serviceClient: 'agency' },
} as const satisfies Record<string, OperationPolicy>

export type OperationId = (typeof operations)[keyof typeof operations]['operationId']

const byId = new Map<OperationId, OperationPolicy>(
  Object.values(operations).map((operation) => [operation.operationId, operation]),
)

export function operationPolicy(operationId: OperationId) {
  const policy = byId.get(operationId)
  if (!policy) throw new Error(`Operation ${operationId} has no authorization policy.`)
  return policy
}

export const scopeCatalog = {
  [scopes.mailboxRead]: 'Read the current Agent mailbox.',
  [scopes.mailboxManage]: 'Manage the current Agent mailbox alias.',
  [scopes.messagesRead]: 'Read messages available to the current Agent mailbox.',
  [scopes.messagesCreate]: 'Create Messages as the current Agent or an authorized service.',
  [scopes.messagesManage]: 'Manage mailbox-local message state.',
  [scopes.subscriptionsRead]: 'Read notification subscriptions owned by the Agency service.',
  [scopes.subscriptionsManage]: 'Create, replace, and delete notification subscriptions owned by the Agency service.',
}
