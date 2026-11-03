import { EventType, type Event } from "@ag-ui/core"

export type WireEvent = {
  readonly id?: string
  readonly type: string
  readonly created?: number
  readonly data?: unknown
}

type RunRef = { readonly threadId: string; readonly runId: string; announced: boolean }
type PartKind = "text" | "reasoning" | "tool"

export class Translator {
  readonly runs = new Map<string, RunRef>()
  readonly suppressed = new Set<string>()
  readonly parts = new Map<string, PartKind>()
  readonly partSession = new Map<string, string>()
  readonly partCall = new Map<string, string>()
  readonly partName = new Map<string, string>()
  readonly openText = new Map<string, string>()
  readonly openReasoning = new Map<string, string>()
  readonly openTools = new Map<string, { readonly sessionID: string; readonly parentMessageId?: string }>()
  readonly toolSession = new Map<string, string>()
  readonly toolArgs = new Set<string>()
  readonly toolEnded = new Set<string>()
  readonly toolResulted = new Set<string>()

  bind(sessionID: string, run: { readonly threadId: string; readonly runId: string; announced?: boolean }) {
    this.suppressed.delete(sessionID)
    this.runs.set(sessionID, {
      threadId: run.threadId,
      runId: run.runId,
      announced: run.announced ?? false,
    })
  }

  /** Drops maps owned by one session after its run ends, so the next run starts clean. */
  release(sessionID: string) {
    this.runs.delete(sessionID)
    this.suppressed.add(sessionID)
    for (const [messageId, owner] of this.openText) if (owner === sessionID) this.openText.delete(messageId)
    for (const [messageId, owner] of this.openReasoning) if (owner === sessionID) this.openReasoning.delete(messageId)
    for (const [id, owner] of this.partSession) {
      if (owner !== sessionID) continue
      this.partSession.delete(id)
      this.parts.delete(id)
      this.partCall.delete(id)
      this.partName.delete(id)
    }
    for (const [id, owner] of this.toolSession) {
      if (owner !== sessionID) continue
      this.toolSession.delete(id)
      this.openTools.delete(id)
      this.toolArgs.delete(id)
      this.toolEnded.delete(id)
      this.toolResulted.delete(id)
    }
  }
}

export function sessionOf(event: WireEvent) {
  const data = asRecord(event.data)
  return stringField(data, "sessionID") ?? stringField(asRecord(data?.part), "sessionID")
}

/** Pure OpenCode event to AG-UI event translation. Unknown events produce nothing. */
export function translate(translator: Translator, event: WireEvent): Event[] {
  const data = asRecord(event.data)
  if (event.type === "session.execution.started") return executionStarted(translator, event, data)
  if (event.type === "session.execution.succeeded") return executionFinished(translator, event, data, "success")
  if (event.type === "session.execution.interrupted") return executionFinished(translator, event, data, "cancelled")
  if (event.type === "session.execution.failed") return executionFailed(translator, event, data)
  if (event.type === "session.error") return sessionError(translator, event, data)
  if (event.type === "session.text.started") return textStarted(translator, event, data)
  if (event.type === "session.text.delta") return textDelta(translator, event, data, stringField(data, "delta") ?? "")
  if (event.type === "session.text.ended") return textEnded(translator, event, data)
  if (event.type === "session.reasoning.started") return reasoningStarted(translator, event, data)
  if (event.type === "session.reasoning.delta")
    return reasoningDelta(translator, event, data, stringField(data, "delta") ?? "")
  if (event.type === "session.reasoning.ended") return reasoningEnded(translator, event, data)
  if (event.type === "session.tool.input.started") return toolStarted(translator, event, data)
  if (event.type === "session.tool.input.delta") return toolDelta(translator, event, data, stringField(data, "delta") ?? "")
  if (event.type === "session.tool.input.ended") return toolEnded(translator, event, data, stringField(data, "text"))
  if (event.type === "session.tool.called") return [...toolEnded(translator, event, data, jsonField(data, "input")), snapshot(event, data)]
  if (event.type === "session.tool.success") return toolResult(translator, event, data, toolContent(data?.content))
  if (event.type === "session.tool.failed")
    return toolResult(translator, event, data, errorMessage(data?.error).message || toolContent(data?.content))
  if (event.type === "session.step.started") return [step(event, data, EventType.STEP_STARTED)]
  if (event.type === "session.step.ended") return [step(event, data, EventType.STEP_FINISHED)]
  if (event.type === "message.part.updated") return partUpdated(translator, event, data)
  if (event.type === "message.part.delta") return partDelta(translator, event, data)
  if (event.type === "session.instructions.updated") return instructionDelta(event, data)
  if (isStateUpdate(event.type)) return [snapshot(event, data)]
  return []
}

function executionStarted(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const sessionID = stringField(data, "sessionID")
  if (!sessionID) return []
  translator.suppressed.delete(sessionID)
  const existing = translator.runs.get(sessionID)
  if (existing?.announced) return []
  const run = runFor(translator, sessionID, event)
  run.announced = true
  return [
    {
      type: EventType.RUN_STARTED,
      timestamp: stamp(event),
      threadId: run.threadId,
      runId: run.runId,
    },
  ]
}

function executionFinished(
  translator: Translator,
  event: WireEvent,
  data: Record<string, unknown> | undefined,
  outcome: "success" | "cancelled",
): Event[] {
  const sessionID = stringField(data, "sessionID")
  if (!sessionID || translator.suppressed.has(sessionID)) return []
  const run = runFor(translator, sessionID, event)
  const closed = closeSession(translator, sessionID, event)
  return [
    ...closed,
    {
      type: EventType.RUN_FINISHED,
      timestamp: stamp(event),
      threadId: run.threadId,
      runId: run.runId,
      outcome: outcome === "cancelled" ? { type: "cancelled" } : { type: "success" },
    },
  ]
}

function executionFailed(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const sessionID = stringField(data, "sessionID")
  const failure = errorMessage(data?.error)
  if (!sessionID) return [runError(event, failure.message, failure.code, "unknown", event.id ?? "run")]
  if (translator.suppressed.has(sessionID)) return []
  const run = runFor(translator, sessionID, event)
  const closed = closeSession(translator, sessionID, event)
  return [...closed, runError(event, failure.message, failure.code ?? "session.execution.failed", run.threadId, run.runId)]
}

function sessionError(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const failure = errorMessage(data?.error)
  const sessionID = stringField(data, "sessionID")
  if (sessionID && translator.suppressed.has(sessionID)) return []
  const run = sessionID ? runFor(translator, sessionID, event) : soleRun(translator)
  const closed = sessionID ? closeSession(translator, sessionID, event) : []
  return [
    ...closed,
    runError(event, failure.message, failure.code ?? "session.error", run?.threadId ?? sessionID ?? "unknown", run?.runId ?? event.id ?? "run"),
  ]
}

function textStarted(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const sessionID = stringField(data, "sessionID")
  const messageId = textMessageId(data)
  if (!sessionID || !messageId || translator.openText.has(messageId)) return []
  translator.openText.set(messageId, sessionID)
  return [textStart(event, messageId)]
}

function textDelta(
  translator: Translator,
  event: WireEvent,
  data: Record<string, unknown> | undefined,
  delta: string,
): Event[] {
  const sessionID = stringField(data, "sessionID")
  const messageId = textMessageId(data)
  if (!sessionID || !messageId) return []
  const open = translator.openText.has(messageId) ? [] : textStarted(translator, event, data)
  return [...open, { type: EventType.TEXT_MESSAGE_CONTENT, timestamp: stamp(event), messageId, delta }]
}

function textEnded(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const messageId = textMessageId(data)
  if (!messageId || !translator.openText.has(messageId)) return []
  translator.openText.delete(messageId)
  return [{ type: EventType.TEXT_MESSAGE_END, timestamp: stamp(event), messageId }]
}

function reasoningStarted(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const sessionID = stringField(data, "sessionID")
  const messageId = reasoningMessageId(data)
  if (!sessionID || !messageId || translator.openReasoning.has(messageId)) return []
  translator.openReasoning.set(messageId, sessionID)
  return [{ type: EventType.REASONING_MESSAGE_START, timestamp: stamp(event), messageId, role: "reasoning" }]
}

function reasoningDelta(
  translator: Translator,
  event: WireEvent,
  data: Record<string, unknown> | undefined,
  delta: string,
): Event[] {
  const messageId = reasoningMessageId(data)
  if (!messageId) return []
  const open = translator.openReasoning.has(messageId) ? [] : reasoningStarted(translator, event, data)
  return [...open, { type: EventType.REASONING_MESSAGE_CONTENT, timestamp: stamp(event), messageId, delta }]
}

function reasoningEnded(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const messageId = reasoningMessageId(data)
  if (!messageId || !translator.openReasoning.has(messageId)) return []
  translator.openReasoning.delete(messageId)
  return [{ type: EventType.REASONING_MESSAGE_END, timestamp: stamp(event), messageId }]
}

function toolStarted(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const sessionID = stringField(data, "sessionID")
  const toolCallId = toolCallIdOf(data)
  if (!sessionID || !toolCallId || translator.openTools.has(toolCallId)) return []
  const parentMessageId = stringField(data, "assistantMessageID") ?? stringField(data, "messageID")
  translator.toolSession.set(toolCallId, sessionID)
  translator.openTools.set(toolCallId, { sessionID, parentMessageId })
  return [
    {
      type: EventType.TOOL_CALL_START,
      timestamp: stamp(event),
      toolCallId,
      toolCallName: stringField(data, "name") ?? stringField(data, "tool") ?? "tool",
      parentMessageId,
    },
  ]
}

function toolDelta(
  translator: Translator,
  event: WireEvent,
  data: Record<string, unknown> | undefined,
  delta: string,
): Event[] {
  const toolCallId = toolCallIdOf(data)
  if (!toolCallId) return []
  const open = translator.openTools.has(toolCallId) ? [] : toolStarted(translator, event, data)
  translator.toolArgs.add(toolCallId)
  return [...open, { type: EventType.TOOL_CALL_ARGS, timestamp: stamp(event), toolCallId, delta }]
}

function toolEnded(
  translator: Translator,
  event: WireEvent,
  data: Record<string, unknown> | undefined,
  fullText: string | undefined,
): Event[] {
  const toolCallId = toolCallIdOf(data)
  if (!toolCallId || translator.toolEnded.has(toolCallId)) return []
  const open = translator.openTools.has(toolCallId) ? [] : toolStarted(translator, event, data)
  const args =
    fullText !== undefined && !translator.toolArgs.has(toolCallId)
      ? toolDelta(translator, event, { ...data, callID: toolCallId, id: toolCallId }, fullText)
      : []
  translator.toolEnded.add(toolCallId)
  translator.openTools.delete(toolCallId)
  return [...open, ...args, { type: EventType.TOOL_CALL_END, timestamp: stamp(event), toolCallId }]
}

function toolResult(
  translator: Translator,
  event: WireEvent,
  data: Record<string, unknown> | undefined,
  content: string,
): Event[] {
  const toolCallId = toolCallIdOf(data)
  if (!toolCallId || translator.toolResulted.has(toolCallId)) return []
  translator.toolResulted.add(toolCallId)
  const ended = translator.toolEnded.has(toolCallId) ? [] : toolEnded(translator, event, data, stringField(data, "text"))
  return [
    ...ended,
    {
      type: EventType.TOOL_CALL_RESULT,
      timestamp: stamp(event),
      messageId: `${toolCallId}:result`,
      toolCallId,
      content,
      role: "tool",
    },
  ]
}

function partUpdated(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const part = asRecord(data?.part)
  rememberPart(translator, part)
  const kind = partKind(part)
  const closed =
    kind === "text" && partFinished(part)
      ? textEnded(translator, event, {
          sessionID: stringField(part, "sessionID") ?? stringField(data, "sessionID"),
          assistantMessageID: stringField(part, "messageID"),
          ordinal: stringField(part, "id"),
        })
      : []
  const reasoning =
    kind === "reasoning" && partFinished(part)
      ? reasoningEnded(translator, event, {
          sessionID: stringField(part, "sessionID") ?? stringField(data, "sessionID"),
          assistantMessageID: stringField(part, "messageID"),
          ordinal: stringField(part, "id"),
        })
      : []
  const tool = kind === "tool" ? toolPartUpdated(translator, event, part) : []
  return [...closed, ...reasoning, ...tool, snapshot(event, data)]
}

function partDelta(translator: Translator, event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const partID = stringField(data, "partID")
  const field = stringField(data, "field") ?? ""
  const delta = stringField(data, "delta") ?? ""
  if (!partID) return []
  const kind = deltaKind(translator, partID, field)
  const sessionID = stringField(data, "sessionID")
  const messageID = stringField(data, "messageID")
  if (kind === "text")
    return textDelta(translator, event, { sessionID, assistantMessageID: messageID, ordinal: partID }, delta)
  if (kind === "reasoning")
    return reasoningDelta(translator, event, { sessionID, assistantMessageID: messageID, ordinal: partID }, delta)
  if (kind === "tool") {
    const toolCallId = translator.partCall.get(partID) ?? partID
    return toolDelta(
      translator,
      event,
      {
        sessionID,
        assistantMessageID: messageID,
        callID: toolCallId,
        id: toolCallId,
        name: translator.partName.get(partID) ?? "tool",
      },
      delta,
    )
  }
  return []
}

function toolPartUpdated(translator: Translator, event: WireEvent, part: Record<string, unknown> | undefined): Event[] {
  const state = asRecord(part?.state)
  const status = stringField(state, "status")
  const sessionID = stringField(part, "sessionID")
  const toolCallId = stringField(part, "callID") ?? stringField(part, "id")
  const payload = {
    sessionID,
    assistantMessageID: stringField(part, "messageID"),
    id: toolCallId,
    name: stringField(part, "tool") ?? "tool",
  }
  if (!toolCallId) return []
  if (status === "completed" || status === "error") {
    const text = stringField(state, "output") ?? stringField(state, "error") ?? ""
    const raw = stringField(state, "raw")
    return toolResult(translator, event, { ...payload, text: raw }, text)
  }
  if (translator.openTools.has(toolCallId)) return []
  return toolStarted(translator, event, payload)
}

function instructionDelta(event: WireEvent, data: Record<string, unknown> | undefined): Event[] {
  const delta = asRecord(data?.delta)
  const sessionID = stringField(data, "sessionID") ?? "session"
  if (!delta) return [snapshot(event, data)]
  return [
    {
      type: EventType.STATE_DELTA,
      timestamp: stamp(event),
      delta: Object.entries(delta).map(([key, value]) => {
        const path = `/sessions/${pointer(sessionID)}/instructions/${pointer(key)}`
        if (value === "removed") return { op: "remove" as const, path }
        return { op: "replace" as const, path, value }
      }),
    },
  ]
}

function closeSession(translator: Translator, sessionID: string, event: WireEvent): Event[] {
  const text = [...translator.openText.entries()].flatMap(([messageId, owner]) => {
    if (owner !== sessionID) return []
    translator.openText.delete(messageId)
    return [{ type: EventType.TEXT_MESSAGE_END, timestamp: stamp(event), messageId } satisfies Event]
  })
  const reasoning = [...translator.openReasoning.entries()].flatMap(([messageId, owner]) => {
    if (owner !== sessionID) return []
    translator.openReasoning.delete(messageId)
    return [{ type: EventType.REASONING_MESSAGE_END, timestamp: stamp(event), messageId } satisfies Event]
  })
  const tools = [...translator.openTools.entries()].flatMap(([toolCallId, open]) => {
    if (open.sessionID !== sessionID) return []
    translator.openTools.delete(toolCallId)
    translator.toolEnded.add(toolCallId)
    return [{ type: EventType.TOOL_CALL_END, timestamp: stamp(event), toolCallId } satisfies Event]
  })
  translator.release(sessionID)
  return [...text, ...reasoning, ...tools]
}

function rememberPart(translator: Translator, part: Record<string, unknown> | undefined) {
  const id = stringField(part, "id")
  const type = stringField(part, "type")
  if (!id) return
  if (type === "text" || type === "reasoning" || type === "tool") translator.parts.set(id, type)
  const sessionID = stringField(part, "sessionID")
  if (sessionID) translator.partSession.set(id, sessionID)
  const callID = stringField(part, "callID")
  if (callID) translator.partCall.set(id, callID)
  const name = stringField(part, "tool")
  if (name) translator.partName.set(id, name)
}

function deltaKind(translator: Translator, partID: string, field: string): PartKind | undefined {
  const known = translator.parts.get(partID)
  if (known === "tool") return "tool"
  if (known === "reasoning" || field === "reasoning") return "reasoning"
  if (known === "text" || field === "text") return "text"
  if (field.includes("input") || field.startsWith("state")) return "tool"
  return undefined
}

function partKind(part: Record<string, unknown> | undefined): PartKind | undefined {
  const type = stringField(part, "type")
  if (type === "text" || type === "reasoning" || type === "tool") return type
  return undefined
}

function partFinished(part: Record<string, unknown> | undefined) {
  const time = asRecord(part?.time)
  return typeof time?.end === "number"
}

function isStateUpdate(type: string) {
  return (
    type.endsWith(".updated") ||
    type === "session.status" ||
    type === "session.idle" ||
    type === "session.step.failed" ||
    type === "session.retry.scheduled" ||
    type === "session.tool.progress" ||
    type === "message.updated" ||
    type === "message.removed" ||
    type === "message.part.removed" ||
    type === "session.diff"
  )
}

function runFor(translator: Translator, sessionID: string, event: WireEvent): RunRef {
  const bound = translator.runs.get(sessionID)
  if (bound) return bound
  const created = { threadId: sessionID, runId: event.id ?? `run_${sessionID}`, announced: false }
  translator.runs.set(sessionID, created)
  return created
}

function toolCallIdOf(data: Record<string, unknown> | undefined) {
  return stringField(data, "callID") ?? stringField(data, "id")
}

function soleRun(translator: Translator) {
  if (translator.runs.size !== 1) return
  return translator.runs.values().next().value
}

function snapshot(event: WireEvent, data: Record<string, unknown> | undefined): Event {
  return {
    type: EventType.STATE_SNAPSHOT,
    timestamp: stamp(event),
    snapshot: { type: event.type, data: data ?? {} },
  }
}

function step(event: WireEvent, data: Record<string, unknown> | undefined, type: EventType.STEP_STARTED | EventType.STEP_FINISHED): Event {
  return {
    type,
    timestamp: stamp(event),
    stepName: stringField(data, "assistantMessageID") ?? "step",
  }
}

function textStart(event: WireEvent, messageId: string): Event {
  return { type: EventType.TEXT_MESSAGE_START, timestamp: stamp(event), messageId, role: "assistant" }
}

function runError(event: WireEvent, message: string, code: string | undefined, threadId: string, runId: string): Event {
  return {
    type: EventType.RUN_ERROR,
    timestamp: stamp(event),
    message,
    code,
    metadata: { threadId, runId },
  }
}

function textMessageId(data: Record<string, unknown> | undefined) {
  const messageID = stringField(data, "assistantMessageID") ?? stringField(data, "messageID")
  if (!messageID) return
  const ordinal = data && "ordinal" in data ? String(data.ordinal) : "0"
  if (ordinal === "") return messageID
  return `${messageID}:${ordinal}`
}

function reasoningMessageId(data: Record<string, unknown> | undefined) {
  const messageID = stringField(data, "assistantMessageID") ?? stringField(data, "messageID")
  if (!messageID) return
  const ordinal = data && "ordinal" in data ? String(data.ordinal) : "0"
  return `${messageID}:reasoning:${ordinal}`
}

function toolContent(value: unknown) {
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) return []
      if (part.type === "text" && "text" in part && typeof part.text === "string") return [part.text]
      if (part.type === "file" && "uri" in part && typeof part.uri === "string") return [`[file] ${part.uri}`]
      return []
    })
    .join("\n")
}

function errorMessage(value: unknown) {
  if (typeof value === "string" && value.length > 0) return { message: value }
  const record = asRecord(value)
  const message = stringField(record, "message") ?? stringField(record, "name") ?? "OpenCode session failed"
  const code = stringField(record, "type") ?? stringField(record, "name")
  return { message, code }
}

function jsonField(data: Record<string, unknown> | undefined, key: string) {
  if (!data || !(key in data)) return
  const value = data[key]
  if (typeof value === "string") return value
  if (value === undefined) return
  return JSON.stringify(value)
}

function stringField(data: Record<string, unknown> | undefined, key: string) {
  if (!data) return
  const value = data[key]
  if (typeof value !== "string" || value.length === 0) return
  return value
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stamp(event: WireEvent) {
  return typeof event.created === "number" ? event.created : undefined
}

function pointer(value: string) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}
