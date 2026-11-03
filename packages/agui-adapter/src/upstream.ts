import { OpenCode } from "@opencode/client"
import type { AdapterConfig } from "./config.js"
import type { WireEvent } from "./translate.js"

export type RequestOptions = { readonly headers?: Record<string, string> }

export type OpenCodeApi = {
  readonly session: {
    readonly get: (input: { readonly sessionID: string }, options?: RequestOptions) => Promise<{ readonly id: string }>
    readonly create: (
      input: { readonly id?: string; readonly title?: string },
      options?: RequestOptions,
    ) => Promise<{ readonly id: string }>
    readonly prompt: (
      input: {
        readonly sessionID: string
        readonly text: string
        readonly metadata?: { readonly [key: string]: string }
      },
      options?: RequestOptions,
    ) => Promise<unknown>
  }
  readonly event: {
    readonly subscribe: (signal: AbortSignal) => AsyncIterable<WireEvent>
  }
}

export function openCodeApi(config: AdapterConfig): OpenCodeApi {
  const client = OpenCode.make({
    baseUrl: config.serverUrl,
    headers: config.authorization ? { authorization: config.authorization } : undefined,
  })
  return {
    session: {
      get: (input, options) => client.session.get(input, options),
      create: (input, options) => client.session.create(input, options),
      prompt: (input, options) => client.session.prompt(input, options),
    },
    event: {
      subscribe(signal) {
        return client.event.subscribe({ signal })
      },
    },
  }
}

export function directoryHeaders(directory?: string): RequestOptions | undefined {
  if (!directory) return
  return { headers: { "x-opencode-directory": encodeURIComponent(directory) } }
}
