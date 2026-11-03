import { Duration, Effect } from "effect"
import { EventType, type Event } from "@ag-ui/core"
import { publicError, type AdapterConfig } from "./config.js"
import { acceptedRun, promptText, resolveDirectory, type AcceptedRun } from "./prompt.js"
import { encodeSse, sseHeaders } from "./sse.js"
import { sessionOf, translate, Translator } from "./translate.js"
import { directoryHeaders, type OpenCodeApi, type RequestOptions } from "./upstream.js"

export type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

const defaultSessionCap = 256
const defaultHighWaterMark = 64
const reconnectCapMs = 10_000

export type ListenOptions = {
  readonly config: AdapterConfig
  readonly api: OpenCodeApi
  readonly run?: RunEffect
  readonly translator?: Translator
  readonly sessionCap?: number
  readonly highWaterMark?: number
  readonly reconnectMinMs?: number
}

type Batch = { readonly sessionID?: string; readonly events: readonly Event[] }
export type Subscriber = {
  desiredSize: () => number | null
  push: (batch: Batch) => void
  drop: () => void
}

/** Delivers one batch. A slow or throwing client is removed and cannot stop the others. */
export function fanout(subscribers: Set<Subscriber>, batch: Batch) {
  for (const subscriber of [...subscribers]) {
    try {
      const queued = subscriber.desiredSize()
      if (queued !== null && queued <= 0) {
        subscribers.delete(subscriber)
        subscriber.drop()
        continue
      }
      subscriber.push(batch)
    } catch {
      subscribers.delete(subscriber)
      try {
        subscriber.drop()
      } catch {
        // The client is already gone; keep the upstream subscription alive.
      }
    }
  }
}

export function listen(options: ListenOptions) {
  const run = options.run ?? ((effect) => Effect.runPromise(effect))
  const translator = options.translator ?? new Translator()
  const sessions = new Map<string, string>()
  const active = new Set<string>()
  const listeners = new Set<Subscriber>()
  const abort = new AbortController()
  const highWaterMark = options.highWaterMark ?? defaultHighWaterMark
  const sessionCap = options.sessionCap ?? defaultSessionCap
  const reconnectMinMs = options.reconnectMinMs ?? 200
  let translationCount = 0
  const traced: { note?: (eventType: string) => void } = {}
  let endTrace = () => {}
  const traceEnded = new Promise<void>((resolve) => {
    endTrace = resolve
  })
  const publish = (batch: Batch) => fanout(listeners, batch)
  const server = Bun.serve({
    hostname: options.config.host,
    port: options.config.port,
    idleTimeout: 0,
    fetch(request) {
      return handle(request, {
        config: options.config,
        api: options.api,
        run,
        translator,
        sessions,
        active,
        listeners,
        publish,
        highWaterMark,
        sessionCap,
      })
    },
  })
  const pumping = pump(options.api, translator, publish, run, abort.signal, traced, reconnectMinMs)
  void run(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      traced.note = (eventType) => {
        translationCount += 1
        const terminal = eventType.startsWith("session.execution.") || eventType === "session.error"
        if (!terminal && translationCount % 32 !== 0) return
        span.event("agui.translate", BigInt(Date.now()) * 1_000_000n, { "opencode.event": eventType })
      }
      yield* Effect.tryPromise(() => traceEnded)
    }).pipe(Effect.withSpan("agui.subscribe")),
  ).catch(() => undefined)
  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    sessions,
    done: pumping,
    stop() {
      abort.abort()
      endTrace()
      server.stop(true)
    },
  }
}

async function pump(
  api: OpenCodeApi,
  translator: Translator,
  publish: (batch: Batch) => void,
  run: RunEffect,
  signal: AbortSignal,
  traced: { note?: (eventType: string) => void },
  reconnectMinMs: number,
) {
  let delay = reconnectMinMs
  while (!signal.aborted) {
    let broken = false
    try {
      for await (const event of api.event.subscribe(signal)) {
        if (signal.aborted) return
        delay = reconnectMinMs
        const events = translate(translator, event)
        if (events.length > 0) publish({ sessionID: sessionOf(event), events })
        traced.note?.(event.type)
      }
      broken = !signal.aborted
    } catch (cause) {
      if (signal.aborted) return
      broken = true
      await run(
        Effect.logWarning("agui event stream interrupted", { message: publicError(cause) }).pipe(
          Effect.withSpan("agui.subscribe"),
        ),
      )
    }
    if (!broken || signal.aborted) return
    failOpenRuns(translator, publish)
    await run(Effect.sleep(Duration.millis(delay)))
    delay = Math.min(delay * 2, reconnectCapMs)
  }
}

function failOpenRuns(translator: Translator, publish: (batch: Batch) => void) {
  for (const sessionID of [...translator.runs.keys()]) {
    const events = translate(translator, {
      type: "session.error",
      data: {
        sessionID,
        error: { message: "OpenCode event stream disconnected", type: "agui.disconnected" },
      },
    })
    if (events.length > 0) publish({ sessionID, events })
  }
}

type Handler = {
  readonly config: AdapterConfig
  readonly api: OpenCodeApi
  readonly run: RunEffect
  readonly translator: Translator
  readonly sessions: Map<string, string>
  readonly active: Set<string>
  readonly listeners: Set<Subscriber>
  readonly publish: (batch: Batch) => void
  readonly highWaterMark: number
  readonly sessionCap: number
}

function handle(request: Request, handler: Handler) {
  const denied = authorize(request, handler.config)
  if (denied) return denied
  const headers = corsHeaders(request, handler.config)
  const url = new URL(request.url)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
  if (request.method === "GET" && url.pathname === "/health")
    return Response.json({ ok: true, host: handler.config.host, port: handler.config.port }, { headers })
  if (request.method === "GET" && url.pathname === "/events") return eventStream(request, handler, headers)
  if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/agent"))
    return postRun(request, handler, headers)
  return new Response("not found", { status: 404, headers })
}

function authorize(request: Request, config: AdapterConfig) {
  const origin = request.headers.get("origin")
  if (origin && !config.allowedOrigins.includes(origin)) return json({ message: "origin is not allowed" }, 403)
  if (config.token && !bearerMatches(request.headers.get("authorization"), config.token))
    return json({ message: "unauthorized" }, 401)
  return
}

async function postRun(request: Request, handler: Handler, headers: Record<string, string>) {
  const text = await request.text()
  if (text.length > 1_000_000) return json({ message: "request body is too large" }, 413, headers)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json({ message: "request body must be JSON" }, 400, headers)
  }
  const input = acceptedRun(body)
  if (!input) return json({ message: "RunAgentInput requires threadId, runId, and messages" }, 400, headers)
  const prompt = promptText(input)
  if (!prompt) return json({ message: "RunAgentInput needs a user message" }, 400, headers)
  if (handler.active.has(input.threadId))
    return json({ message: "a run is already active for this thread" }, 409, headers)
  handler.active.add(input.threadId)
  const release = () => handler.active.delete(input.threadId)
  request.signal.addEventListener("abort", release, { once: true })
  return eventStream(request, handler, headers, { input, prompt, release })
}

function eventStream(
  request: Request,
  handler: Handler,
  headers: Record<string, string>,
  run?: { readonly input: AcceptedRun; readonly prompt: string; readonly release: () => void },
) {
  const encoder = new TextEncoder()
  const focus = { sessionID: undefined as string | undefined }
  const clientAbort = new AbortController()
  let closed = false
  let subscriber: Subscriber | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let settle = () => {}
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  let settled = false
  const finish = () => {
    if (settled) return false
    settled = true
    settle()
    return true
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const emit = (chunk: string) => {
          if (closed) return
          controller.enqueue(encoder.encode(chunk))
        }
        const close = () => {
          if (closed) return
          closed = true
          if (subscriber) handler.listeners.delete(subscriber)
          if (timer) clearInterval(timer)
          finish()
          controller.close()
        }
        const fail = (message: string) => {
          if (!finish()) return
          try {
            emit(encodeSse({ type: EventType.RUN_ERROR, message }))
          } catch {
            // The client already stopped reading.
          }
          close()
        }
        subscriber = {
          desiredSize: () => controller.desiredSize,
          push: (batch) => {
            if (run && batch.sessionID !== focus.sessionID) return
            let terminal = false
            for (const event of batch.events) {
              emit(encodeSse(event))
              if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) terminal = true
            }
            if (run && terminal) close()
          },
          drop: () => close(),
        }
        handler.listeners.add(subscriber)
        emit(": connected\n\n")
        timer = setInterval(() => emit(": heartbeat\n\n"), 15_000)
        request.signal.addEventListener(
          "abort",
          () => {
            clientAbort.abort()
            close()
          },
          { once: true },
        )
        if (request.signal.aborted) {
          clientAbort.abort()
          run?.release()
          close()
          return
        }
        if (!run) return
        const directory = resolveDirectory(run.input.forwardedProps, handler.config)
        void admit(handler, run.input, run.prompt, directory, focus, done, clientAbort.signal)
          .then(() => close())
          .catch((cause) => fail(publicError(cause)))
          .finally(run.release)
      },
      cancel() {
        clientAbort.abort()
        finish()
        if (subscriber) handler.listeners.delete(subscriber)
        if (timer) clearInterval(timer)
        closed = true
      },
    },
    { highWaterMark: handler.highWaterMark },
  )
  return new Response(stream, { headers: { ...sseHeaders, ...headers } })
}

async function admit(
  handler: Handler,
  input: AcceptedRun,
  prompt: string,
  directory: string | undefined,
  focus: { sessionID?: string },
  done: Promise<void>,
  clientAbort: AbortSignal,
) {
  const sessionID = await ensureSession(handler, input.threadId, directory)
  focus.sessionID = sessionID
  handler.translator.bind(sessionID, { threadId: input.threadId, runId: input.runId, announced: true })
  handler.publish({
    sessionID,
    events: [{ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId }],
  })
  const request = directoryHeaders(directory)
  await handler.run(
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        handler.api.session.prompt(
          { sessionID, text: prompt, metadata: { source: "agui", runId: input.runId } },
          request,
        ),
      )
      yield* Effect.tryPromise(() => waitForTerminal(done, clientAbort, handler.config.runTimeoutMs))
    }).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(async () => {
          await interrupt(handler.api, sessionID, request)
          handler.translator.release(sessionID)
        }),
      ),
      Effect.withSpan("agui.run", {
        attributes: {
          "agui.thread_id": input.threadId,
          "agui.run_id": input.runId,
          "opencode.session_id": sessionID,
        },
      }),
    ),
  )
}

function waitForTerminal(done: Promise<void>, signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) return Promise.reject(new Error("client disconnected"))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for the OpenCode run to finish")), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("client disconnected"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    void done.then(() => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve()
    })
  })
}

async function interrupt(api: OpenCodeApi, sessionID: string, options: RequestOptions | undefined) {
  await api.session.interrupt({ sessionID }, options).catch(() => undefined)
}

async function ensureSession(handler: Handler, threadId: string, directory: string | undefined) {
  const known = handler.sessions.get(threadId)
  if (known) {
    rememberSession(handler.sessions, threadId, known, handler.sessionCap)
    return known
  }
  const headers = directoryHeaders(directory)
  if (threadId.startsWith("ses_")) {
    const existing = await handler.api.session.get({ sessionID: threadId }, headers).catch(() => undefined)
    if (existing) {
      rememberSession(handler.sessions, threadId, existing.id, handler.sessionCap)
      return existing.id
    }
  }
  const created = await handler.api.session.create(
    { id: threadId.startsWith("ses_") ? threadId : undefined, title: "AG-UI" },
    headers,
  )
  rememberSession(handler.sessions, threadId, created.id, handler.sessionCap)
  return created.id
}

function rememberSession(sessions: Map<string, string>, threadId: string, sessionID: string, cap: number) {
  sessions.delete(threadId)
  sessions.set(threadId, sessionID)
  while (sessions.size > cap) {
    const oldest = sessions.keys().next().value
    if (oldest === undefined || oldest === threadId) return
    sessions.delete(oldest)
  }
}

function bearerMatches(header: string | null, token: string) {
  if (!header?.startsWith("Bearer ")) return false
  const presented = Buffer.from(header.slice("Bearer ".length))
  const expected = Buffer.from(token)
  if (presented.length !== expected.length) return false
  return crypto.timingSafeEqual(presented, expected)
}

function corsHeaders(request: Request, config: AdapterConfig): Record<string, string> {
  const origin = request.headers.get("origin")
  if (!origin || !config.allowedOrigins.includes(origin)) return {}
  return {
    vary: "origin",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  }
}

function json(body: { readonly message: string }, status: number, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers })
}
