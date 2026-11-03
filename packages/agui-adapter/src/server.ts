import { Effect } from "effect"
import { EventType, type Event } from "@ag-ui/core"
import { publicError, type AdapterConfig } from "./config.js"
import { acceptedRun, directoryFrom, promptText, type AcceptedRun } from "./prompt.js"
import { encodeSse, sseHeaders } from "./sse.js"
import { sessionOf, translate, Translator, type WireEvent } from "./translate.js"
import { directoryHeaders, type OpenCodeApi } from "./upstream.js"

export type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>

export type ListenOptions = {
  readonly config: AdapterConfig
  readonly api: OpenCodeApi
  readonly run?: RunEffect
  readonly translator?: Translator
}

type Batch = { readonly sessionID?: string; readonly events: readonly Event[] }
type Listener = (batch: Batch) => void

export function listen(options: ListenOptions) {
  const run = options.run ?? ((effect) => Effect.runPromise(effect))
  const translator = options.translator ?? new Translator()
  const sessions = new Map<string, string>()
  const listeners = new Set<Listener>()
  const abort = new AbortController()
  const publish = (batch: Batch) => {
    for (const listener of listeners) listener(batch)
  }
  const server = Bun.serve({
    hostname: options.config.host,
    port: options.config.port,
    fetch(request) {
      return handle(request, { config: options.config, api: options.api, run, translator, sessions, listeners })
    },
  })
  const pumping = pump(options.api, translator, publish, run, abort.signal)
  return {
    url: `http://${server.hostname}:${server.port}`,
    port: server.port,
    done: pumping,
    stop() {
      abort.abort()
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
) {
  while (!signal.aborted) {
    try {
      for await (const event of api.event.subscribe(signal)) {
        if (signal.aborted) return
        await run(observedTranslate(event, translator, publish))
      }
    } catch (cause) {
      if (signal.aborted) return
      await run(
        Effect.logWarning("agui event stream interrupted", { message: publicError(cause) }).pipe(
          Effect.withSpan("agui.subscribe"),
        ),
      )
    }
    if (signal.aborted) return
    await Effect.runPromise(Effect.sleep("1 second"))
  }
}

function observedTranslate(event: WireEvent, translator: Translator, publish: (batch: Batch) => void) {
  return Effect.sync(() => {
    const events = translate(translator, event)
    if (events.length === 0) return
    publish({ sessionID: sessionOf(event), events })
  }).pipe(Effect.withSpan("agui.translate", { attributes: { "opencode.event": event.type } }))
}

type Handler = {
  readonly config: AdapterConfig
  readonly api: OpenCodeApi
  readonly run: RunEffect
  readonly translator: Translator
  readonly sessions: Map<string, string>
  readonly listeners: Set<Listener>
}

function handle(request: Request, handler: Handler) {
  const url = new URL(request.url)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(handler.config.host) })
  if (request.method === "GET" && url.pathname === "/health")
    return Response.json({ ok: true, host: handler.config.host, port: handler.config.port }, { headers: cors(handler.config.host) })
  if (request.method === "GET" && url.pathname === "/events") return eventStream(request, handler)
  if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/agent")) return postRun(request, handler)
  return new Response("not found", { status: 404, headers: cors(handler.config.host) })
}

async function postRun(request: Request, handler: Handler) {
  const text = await request.text()
  if (text.length > 1_000_000) return json({ message: "request body is too large" }, 413, handler.config.host)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json({ message: "request body must be JSON" }, 400, handler.config.host)
  }
  const input = acceptedRun(body)
  if (!input) return json({ message: "RunAgentInput requires threadId, runId, and messages" }, 400, handler.config.host)
  const prompt = promptText(input)
  if (!prompt) return json({ message: "RunAgentInput needs a user message" }, 400, handler.config.host)
  return eventStream(request, handler, { input, prompt })
}

function eventStream(
  request: Request,
  handler: Handler,
  run?: { readonly input: AcceptedRun; readonly prompt: string },
) {
  const encoder = new TextEncoder()
  const focus = { sessionID: undefined as string | undefined }
  let closed = false
  let unsubscribe = () => {}
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
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (chunk: string) => {
        if (closed) return
        controller.enqueue(encoder.encode(chunk))
      }
      const close = () => {
        if (closed) return
        closed = true
        unsubscribe()
        if (timer) clearInterval(timer)
        finish()
        controller.close()
      }
      const fail = (message: string) => {
        if (!finish()) return
        emit(encodeSse({ type: EventType.RUN_ERROR, message }))
        close()
      }
      const listener: Listener = (batch) => {
        if (run && batch.sessionID !== focus.sessionID) return
        let terminal = false
        for (const event of batch.events) {
          emit(encodeSse(event))
          if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) terminal = true
        }
        if (run && terminal) close()
      }
      handler.listeners.add(listener)
      unsubscribe = () => handler.listeners.delete(listener)
      timer = setInterval(() => emit(": heartbeat\n\n"), 15_000)
      request.signal.addEventListener("abort", () => close(), { once: true })
      if (!run) return
      const directory = directoryFrom(run.input.forwardedProps, handler.config.directory)
      void admit(handler, run.input, run.prompt, directory, focus, done).then(
        () => close(),
        (cause) => fail(publicError(cause)),
      )
    },
    cancel() {
      finish()
      unsubscribe()
      if (timer) clearInterval(timer)
      closed = true
    },
  })
  return new Response(stream, { headers: { ...sseHeaders, ...cors(handler.config.host) } })
}

async function admit(
  handler: Handler,
  input: AcceptedRun,
  prompt: string,
  directory: string | undefined,
  focus: { sessionID?: string },
  done: Promise<void>,
) {
  const sessionID = await ensureSession(handler, input.threadId, directory)
  focus.sessionID = sessionID
  handler.translator.bind(sessionID, { threadId: input.threadId, runId: input.runId })
  const headers = directoryHeaders(directory)
  await handler.run(
    Effect.tryPromise(() =>
      handler.api.session.prompt({ sessionID, text: prompt, metadata: { source: "agui", runId: input.runId } }, headers),
    ).pipe(
      Effect.withSpan("agui.run", {
        attributes: { "agui.thread_id": input.threadId, "agui.run_id": input.runId, "opencode.session_id": sessionID },
      }),
    ),
  )
  await Promise.race([
    done,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the OpenCode run to finish")),
        handler.config.runTimeoutMs,
      )
      void done.then(() => clearTimeout(timer))
    }),
  ])
}

async function ensureSession(handler: Handler, threadId: string, directory: string | undefined) {
  const known = handler.sessions.get(threadId)
  if (known) return known
  const headers = directoryHeaders(directory)
  if (threadId.startsWith("ses_")) {
    const existing = await handler.api.session.get({ sessionID: threadId }, headers).catch(() => undefined)
    if (existing) {
      handler.sessions.set(threadId, existing.id)
      return existing.id
    }
  }
  const created = await handler.api.session.create(
    { id: threadId.startsWith("ses_") ? threadId : undefined, title: "AG-UI" },
    headers,
  )
  handler.sessions.set(threadId, created.id)
  return created.id
}

function json(body: { readonly message: string }, status: number, host: string) {
  return Response.json(body, { status, headers: cors(host) })
}

function cors(host: string): Record<string, string> {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return { vary: "origin" }
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  }
}
