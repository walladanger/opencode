import { afterEach, describe, expect, test } from "bun:test"
import { configFromEnv, publicConfig } from "../src/config.js"
import { resolveDirectory } from "../src/prompt.js"
import { fanout, listen, type Subscriber } from "../src/server.js"
import { Translator, type WireEvent } from "../src/translate.js"
import type { OpenCodeApi } from "../src/upstream.js"

const secret = "super-secret-value"

describe("config guards", () => {
  test("refuses a non-loopback host until AGUI_TOKEN is set", () => {
    expect(() => configFromEnv({ AGUI_HOST: "0.0.0.0" })).toThrow(/AGUI_TOKEN/)
    const config = configFromEnv({ AGUI_HOST: "0.0.0.0", AGUI_TOKEN: secret })
    expect(config.token).toBe(secret)
    expect(JSON.stringify(publicConfig(config)).includes(secret)).toBe(false)
    expect(publicConfig(config).token).toBe("configured")
  })

  test("ignores a forwarded directory that is not the server directory or the allowlist", () => {
    expect(resolveDirectory({ directory: "/evil" }, { directory: "/work", allowedDirectories: [] })).toBe("/work")
    expect(resolveDirectory({ directory: "/work" }, { directory: "/work", allowedDirectories: [] })).toBe("/work")
    expect(resolveDirectory({ directory: "/allowed" }, { directory: "/work", allowedDirectories: ["/allowed"] })).toBe(
      "/allowed",
    )
    expect(resolveDirectory({}, { directory: "/work", allowedDirectories: [] })).toBe("/work")
    const config = configFromEnv({
      OPENCODE_SERVER_DIRECTORY: "/work",
      AGUI_ALLOWED_DIRECTORIES: "/opt/extra, /opt/other",
    })
    expect(config.allowedDirectories).toEqual(["/opt/extra", "/opt/other"])
  })
})

describe("http guards", () => {
  const stops: Array<() => void> = []

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
  })

  test("rejects a present Origin that is not on the allowlist and never sends a wildcard", async () => {
    const adapter = start(configFromEnv({ AGUI_PORT: "0" }), {})
    const denied = await fetch(adapter.url + "/health", { headers: { origin: "https://evil.test" } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
    const open = await fetch(adapter.url + "/health")
    expect(open.status).toBe(200)
    expect(open.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("echoes only an allowlisted origin", async () => {
    const adapter = start(
      configFromEnv({ AGUI_PORT: "0", AGUI_ALLOWED_ORIGINS: "https://app.test" }),
      {},
    )
    const allowed = await fetch(adapter.url + "/health", { headers: { origin: "https://app.test" } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test")
    const denied = await fetch(adapter.url + "/health", { headers: { origin: "https://other.test" } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("requires the bearer token on every request when AGUI_TOKEN is set", async () => {
    const adapter = start(configFromEnv({ AGUI_PORT: "0", AGUI_TOKEN: secret }), {})
    const missing = await fetch(adapter.url + "/health")
    expect(missing.status).toBe(401)
    expect(await missing.text()).not.toContain(secret)
    const wrong = await fetch(adapter.url + "/health", { headers: { authorization: "Bearer no" } })
    expect(wrong.status).toBe(401)
    const ok = await fetch(adapter.url + "/health", { headers: { authorization: `Bearer ${secret}` } })
    expect(ok.status).toBe(200)
  })

  test("returns 409 when a thread already has an active run", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const adapter = start(configFromEnv({ AGUI_PORT: "0", AGUI_RUN_TIMEOUT_MS: "5000" }), {
      prompt: async (input) => {
        prompts.push(input.sessionID)
        await gate
        push({ id: "evt_done", type: "session.execution.succeeded", created: 3, data: { sessionID: input.sessionID } })
        return {}
      },
    })
    const first = await fetch(adapter.url, { method: "POST", headers: jsonHeaders, body: runBody("thread-1", "run-1") })
    const body = readUntil(first, "RUN_FINISHED")
    await waitFor(() => prompts.length === 1)
    const second = await fetch(adapter.url, { method: "POST", headers: jsonHeaders, body: runBody("thread-1", "run-2") })
    expect(second.status).toBe(409)
    release()
    expect(await body).toContain("RUN_FINISHED")
  })

  test("interrupts the OpenCode session and clears translator state when the client disconnects", async () => {
    const interrupts: string[] = []
    const prompts: string[] = []
    const translator = new Translator()
    const adapter = start(configFromEnv({ AGUI_PORT: "0", AGUI_RUN_TIMEOUT_MS: "5000" }), {
      translator,
      interrupt: async (input) => {
        interrupts.push(input.sessionID)
        return {}
      },
      prompt: async (input) => {
        prompts.push(input.sessionID)
        return {}
      },
    })
    const controller = new AbortController()
    const response = await fetch(adapter.url, {
      method: "POST",
      headers: jsonHeaders,
      body: runBody("thread-1", "run-1"),
      signal: controller.signal,
    })
    const reading = response.body?.getReader().read()
    await waitFor(() => prompts.length === 1)
    const { translate } = await import("../src/translate.js")
    translate(translator, {
      id: "evt_text",
      type: "session.text.delta",
      created: 2,
      data: { sessionID: prompts[0], assistantMessageID: "msg_1", ordinal: 0, delta: "x" },
    })
    expect(translator.openText.size).toBe(1)
    controller.abort()
    await reading?.catch(() => undefined)
    await waitFor(() => interrupts.length === 1)
    expect(interrupts).toEqual([prompts[0]])
    expect(translator.runs.size).toBe(0)
    expect(translator.openText.size).toBe(0)
  })

  test("emits RUN_ERROR for open runs when the upstream subscription breaks", async () => {
    const translator = new Translator()
    let failNext = false
    const adapter = start(
      configFromEnv({ AGUI_PORT: "0" }),
      { translator, reconnectMinMs: 20 },
      () => {
        if (!failNext) return
        failNext = false
        throw new Error("socket closed")
      },
    )
    await waitFor(() => waiting.length > 0)
    const response = await fetch(adapter.url + "/events")
    const body = readUntil(response, "agui.disconnected")
    translator.bind("ses_open", { threadId: "thread-open", runId: "run-open" })
    wake()
    expect(await body).toContain("OpenCode event stream disconnected")
    expect(translator.runs.has("ses_open")).toBe(false)
  })

  test("drops a slow or broken client without stopping the others", () => {
    const seen: string[] = []
    const dropped: string[] = []
    const subscribers = new Set<Subscriber>([
      {
        desiredSize: () => 0,
        push: () => {
          throw new Error("should have been dropped before push")
        },
        drop: () => dropped.push("slow"),
      },
      {
        desiredSize: () => 1,
        push: () => {
          throw new Error("broken client")
        },
        drop: () => dropped.push("broken"),
      },
      {
        desiredSize: () => 4,
        push: () => seen.push("ok"),
        drop: () => dropped.push("ok"),
      },
    ])
    const batch = { events: [] }
    fanout(subscribers, batch)
    fanout(subscribers, batch)
    expect(seen).toEqual(["ok", "ok"])
    expect(dropped).toEqual(["slow", "broken"])
    expect(subscribers.size).toBe(1)
  })

  test("caps the session map", async () => {
    const adapter = start(configFromEnv({ AGUI_PORT: "0", AGUI_RUN_TIMEOUT_MS: "5000" }), { sessionCap: 2 })
    for (const threadId of ["thread-a", "thread-b", "thread-c"]) {
      const response = await fetch(adapter.url, {
        method: "POST",
        headers: jsonHeaders,
        body: runBody(threadId, `run-${threadId}`),
      })
      expect(await readUntil(response, "RUN_FINISHED")).toContain("RUN_FINISHED")
    }
    expect(adapter.sessions.size).toBe(2)
  })

  function start(
    config: ReturnType<typeof configFromEnv>,
    options: {
      translator?: Translator
      sessionCap?: number
      highWaterMark?: number
      reconnectMinMs?: number
      prompt?: OpenCodeApi["session"]["prompt"]
      interrupt?: OpenCodeApi["session"]["interrupt"]
    },
    failNext?: () => void,
  ) {
    resetQueue()
    const adapter = listen({
      config,
      api: api(options.prompt, options.interrupt, failNext),
      translator: options.translator,
      sessionCap: options.sessionCap,
      highWaterMark: options.highWaterMark,
      reconnectMinMs: options.reconnectMinMs,
    })
    stops.push(() => adapter.stop())
    return adapter
  }
})

const jsonHeaders = { "content-type": "application/json" }

function runBody(threadId: string, runId: string) {
  return JSON.stringify({
    threadId,
    runId,
    messages: [{ id: "m1", role: "user", content: "hello" }],
  })
}

const waiting: Array<(result: { ok: true; value: WireEvent } | { ok: false }) => void> = []
const buffered: WireEvent[] = []

function resetQueue() {
  waiting.splice(0)
  buffered.splice(0)
}

function wake() {
  const next = waiting.shift()
  next?.({ ok: false })
}

function push(event: WireEvent) {
  const next = waiting.shift()
  if (next) {
    next({ ok: true, value: event })
    return
  }
  buffered.push(event)
}

function api(
  prompt: OpenCodeApi["session"]["prompt"] | undefined,
  interrupt: OpenCodeApi["session"]["interrupt"] | undefined,
  failNext?: () => void,
): OpenCodeApi {
  return {
    session: {
      get: async () => {
        throw new Error("missing")
      },
      create: async (input) => ({ id: input.id ?? `ses_${input.title ?? "created"}` }),
      prompt:
        prompt ??
        (async (input) => {
          push({
            id: "evt_done",
            type: "session.execution.succeeded",
            created: 1,
            data: { sessionID: input.sessionID },
          })
          return {}
        }),
      interrupt: interrupt ?? (async () => ({})),
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
            failNext?.()
            const queued = buffered.shift()
            if (queued) return { done: false, value: queued }
            const result = await new Promise<{ ok: true; value: WireEvent } | { ok: false }>((resolve) =>
              waiting.push(resolve),
            )
            if (!result.ok) throw new Error("aborted")
            return { done: false, value: result.value }
          },
        }
        return { [Symbol.asyncIterator]: () => iterator }
      },
    },
  }
}

async function readUntil(response: Response, marker: string) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("missing body")
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 4_000
  while (!text.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`timed out reading SSE: ${text}`)
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value)
  }
  return text
}

async function waitFor(ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3_000
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
