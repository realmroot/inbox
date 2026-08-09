import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly type: string,
    readonly title: string,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const badRequest = (message: string) =>
  new ApiError(400, 'https://inbox.realmroot.dev/problems/invalid-request', 'Invalid request', message)
export const unauthorized = (message: string, headers?: HeadersInit) =>
  new ApiError(401, 'https://inbox.realmroot.dev/problems/unauthorized', 'Unauthorized', message, headers)
export const forbidden = (message: string, headers?: HeadersInit) =>
  new ApiError(403, 'https://inbox.realmroot.dev/problems/forbidden', 'Forbidden', message, headers)
export const notFound = (message: string) =>
  new ApiError(404, 'https://inbox.realmroot.dev/problems/not-found', 'Not found', message)
export const conflict = (message: string) =>
  new ApiError(409, 'https://inbox.realmroot.dev/problems/conflict', 'Conflict', message)
export const preconditionRequired = (message: string) =>
  new ApiError(428, 'https://inbox.realmroot.dev/problems/precondition-required', 'Precondition required', message)
export const preconditionFailed = (message: string) =>
  new ApiError(412, 'https://inbox.realmroot.dev/problems/precondition-failed', 'Precondition failed', message)

