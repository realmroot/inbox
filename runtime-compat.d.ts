// postal-mime accepts Node Buffers but Agent Inbox only supplies Worker-native values.
type Buffer = Uint8Array<ArrayBuffer>

declare namespace Cloudflare {
  interface Env {
    AGENCY_CLIENT_ID: string
    DELIVERY_SECRET_KEY: string
  }
}
