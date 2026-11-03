import { afterEach, describe, expect, test } from "bun:test"
import { configFromEnv } from "../src/config.js"
import { listen } from "../src/server.js"
import type { OpenCodeApi, RequestOptions } from "../src/upstream.js"
import type { WireEvent } from "../src/translate.js"

const waiting: Array<(result: { ok: true; value: WireEvent } | { ok: false }) => void> = []
const buffered: WireEvent[] = []

const prompts: Array<{ readonly sessionID: string; readonly text: string; readonly headers?: RequestOptions }> = []

function resetQueue() {
  waiting.splice(0)
  buffered.splice(0)
  prompts.splice(0)
}

function push(event: WireEvent) {
  const next = waiting.shift()
  if (next) {
    next({ ok: true, value: event })
    return
  }
  buffered.push(event)
}

const api: OpenCodeApi = {
  session: {
    get: async () => {
      throw new Error("missing")
    },
    create: async (input) => ({ id: input.id ?? "ses_created" }),
    interrupt: async () => ({}),
    prompt: async (input, options) => {
      prompts.push({ sessionID: input.sessionID, text: input.text, headers: options })
      const sessionID = input.sessionID
      push({ id: "evt_start", type: "session.execution.started", created: 1, data: { sessionID } })
      push({
        id: "evt_text",
        type: "session.text.delta",
        created: 2,
        data: { sessionID, assistantMessageID: "msg_1", ordinal: 0, delta: "yo" },
      })
      push({ id: "evt_done", type: "session.execution.succeeded", created: 3, data: { sessionID } })
      return {}
    },
  },
  event: {
    subscribe(signal): AsyncIterable<WireEvent> {
      signal.addEventListener(
        "abort",
        () => {
          for (const resolve of waiting.splice(0)) resolve({ ok: false })
        },
        { once: true },
      )
      const iterator: AsyncIterator<WireEvent> = {
        async next() {
          const queued = buffered.shift()
          if (queued) return { done: false, value: queued }
          const result = await new Promise<{ ok: true; value: WireEvent } | { ok: false }>((resolve) => waiting.push(resolve))
          if (!result.ok) throw new Error("aborted")
          return { done: false, value: result.value }
        },
      }
      return {
        [Symbol.asyncIterator]() {
          return iterator
        },
      }
    },
  },
}

describe("listen", () => {
  let stop = () => {}

  afterEach(() => {
    stop()
  })

  test("forwards RunAgentInput and streams the translated run", async () => {
    resetQueue()
    const adapter = listen({
      config: configFromEnv({
        AGUI_HOST: "127.0.0.1",
        AGUI_PORT: "0",
        AGUI_RUN_TIMEOUT_MS: "5000",
        AGUI_ALLOWED_DIRECTORIES: "/work tree",
      }),
      api,
    })
    stop = () => adapter.stop()

    const response = await fetch(adapter.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "m1", role: "user", content: "hello" }],
        forwardedProps: { directory: "/work tree" },
      }),
    })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await readUntil(response, "RUN_FINISHED")
    expect(prompts).toEqual([
      {
        sessionID: "ses_created",
        text: "hello",
        headers: { headers: { "x-opencode-directory": encodeURIComponent("/work tree") } },
      },
    ])
    expect(body.match(/"type":"RUN_STARTED"/g)?.length).toBe(1)
    expect(body).toContain('"threadId":"thread-1"')
    expect(body).toContain('"runId":"run-1"')
    expect(body).toContain('"type":"TEXT_MESSAGE_CONTENT"')
    expect(body).toContain('"delta":"yo"')
    expect(body).toContain('"type":"RUN_FINISHED"')
  })
})

async function readUntil(response: Response, marker: string) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("missing body")
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 5_000
  while (!text.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`timed out reading SSE: ${text}`)
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value)
  }
  return text
}
