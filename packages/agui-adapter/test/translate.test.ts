import { describe, expect, test } from "bun:test"
import { EventType } from "@ag-ui/core"
import { Translator, translate, type WireEvent } from "../src/translate.js"

const session = "ses_1"

describe("translate", () => {
  test("maps execution lifecycle onto a bound AG-UI run", () => {
    const translator = new Translator()
    translator.bind(session, { threadId: "thread-1", runId: "run-1" })
    const events = flat(
      translator,
      event("session.execution.started", { sessionID: session }),
      event("session.text.started", { sessionID: session, assistantMessageID: "msg_1", ordinal: 0 }),
      event("session.text.delta", { sessionID: session, assistantMessageID: "msg_1", ordinal: 0, delta: "Hi" }),
      event("session.text.ended", { sessionID: session, assistantMessageID: "msg_1", ordinal: 0, text: "Hi" }),
      event("session.tool.input.started", {
        sessionID: session,
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "read",
      }),
      event("session.tool.input.delta", { sessionID: session, assistantMessageID: "msg_1", id: "call_1", delta: "{" }),
      event("session.tool.input.ended", {
        sessionID: session,
        assistantMessageID: "msg_1",
        id: "call_1",
        text: "{}",
      }),
      event("session.tool.success", {
        sessionID: session,
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "ok" }],
      }),
      event("session.execution.succeeded", { sessionID: session }),
    )
    expect(events.map((item) => item.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ])
    expect(events[0]).toMatchObject({ threadId: "thread-1", runId: "run-1" })
    expect(events[2]).toMatchObject({ messageId: "msg_1:0", delta: "Hi" })
    expect(events[4]).toMatchObject({ toolCallId: "call_1", toolCallName: "read", parentMessageId: "msg_1" })
    expect(events[7]).toMatchObject({ toolCallId: "call_1", content: "ok", role: "tool" })
    expect(events[8]).toMatchObject({ outcome: { type: "success" }, threadId: "thread-1", runId: "run-1" })
  })

  test("maps execution failure and session.error to RUN_ERROR", () => {
    const translator = new Translator()
    translator.bind(session, { threadId: "thread-1", runId: "run-1" })
    const failed = translate(
      translator,
      event("session.execution.failed", { sessionID: session, error: { type: "ProviderError", message: "nope" } }),
    )
    expect(failed.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      message: "nope",
      code: "ProviderError",
      metadata: { threadId: "thread-1", runId: "run-1" },
    })

    const other = new Translator()
    const legacy = translate(other, event("session.error", { sessionID: session, error: { message: "boom" } }))
    expect(legacy.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "boom", code: "session.error" })
  })

  test("maps an interrupted execution to a cancelled run", () => {
    const translator = new Translator()
    const events = translate(
      translator,
      event("session.execution.interrupted", { sessionID: session, reason: "user" }, "evt_stop"),
    )
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.RUN_FINISHED,
        threadId: session,
        runId: "evt_stop",
        outcome: { type: "cancelled" },
      }),
    ])
  })

  test("maps message.part.delta text parts to a text message", () => {
    const translator = new Translator()
    const events = flat(
      translator,
      event("message.part.updated", {
        sessionID: session,
        part: { id: "prt_1", type: "text", messageID: "msg_1", sessionID: session, text: "" },
      }),
      event("message.part.delta", { sessionID: session, messageID: "msg_1", partID: "prt_1", field: "text", delta: "hel" }),
      event("message.part.delta", { sessionID: session, messageID: "msg_1", partID: "prt_1", field: "text", delta: "lo" }),
      event("message.part.updated", {
        sessionID: session,
        part: {
          id: "prt_1",
          type: "text",
          messageID: "msg_1",
          sessionID: session,
          text: "hello",
          time: { start: 1, end: 2 },
        },
      }),
    )
    expect(events.map((item) => item.type)).toEqual([
      EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.STATE_SNAPSHOT,
    ])
    expect(events[2]).toMatchObject({ delta: "hel" })
    expect(events[3]).toMatchObject({ delta: "lo" })
  })

  test("maps message.part.delta tool parts to tool calls", () => {
    const translator = new Translator()
    const events = flat(
      translator,
      event("message.part.updated", {
        sessionID: session,
        part: {
          id: "prt_tool",
          type: "tool",
          messageID: "msg_1",
          sessionID: session,
          callID: "call_9",
          tool: "bash",
          state: { status: "pending", input: {}, raw: "" },
        },
      }),
      event("message.part.delta", {
        sessionID: session,
        messageID: "msg_1",
        partID: "prt_tool",
        field: "state.input",
        delta: "{\"cmd\":",
      }),
      event("message.part.updated", {
        sessionID: session,
        part: {
          id: "prt_tool",
          type: "tool",
          messageID: "msg_1",
          sessionID: session,
          callID: "call_9",
          tool: "bash",
          state: { status: "completed", output: "done", input: {}, raw: "{\"cmd\":\"ls\"}" },
        },
      }),
    )
    expect(events.map((item) => item.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.STATE_SNAPSHOT,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.STATE_SNAPSHOT,
    ])
    expect(events[0]).toMatchObject({ toolCallId: "call_9", toolCallName: "bash", parentMessageId: "msg_1" })
    expect(events[2]).toMatchObject({ toolCallId: "call_9", delta: "{\"cmd\":" })
    expect(events[4]).toMatchObject({ toolCallId: "call_9", content: "done" })
  })

  test("maps session updates to state snapshots and instruction deltas to JSON patch", () => {
    const translator = new Translator()
    const updated = translate(translator, event("session.updated", { sessionID: session, info: { title: "Hello" } }))
    expect(updated).toEqual([
      expect.objectContaining({
        type: EventType.STATE_SNAPSHOT,
        snapshot: { type: "session.updated", data: { sessionID: session, info: { title: "Hello" } } },
      }),
    ])
    const status = translate(translator, event("session.status", { sessionID: session, status: { type: "busy" } }))
    expect(status[0]).toMatchObject({ type: EventType.STATE_SNAPSHOT })
    const delta = translate(
      translator,
      event("session.instructions.updated", {
        sessionID: session,
        delta: { guide: "hash", stale: "removed" },
      }),
    )
    expect(delta).toEqual([
      expect.objectContaining({
        type: EventType.STATE_DELTA,
        delta: [
          { op: "replace", path: `/sessions/${session}/instructions/guide`, value: "hash" },
          { op: "remove", path: `/sessions/${session}/instructions/stale` },
        ],
      }),
    ])
  })

  test("closes an open text message when the run finishes", () => {
    const translator = new Translator()
    translate(translator, event("session.text.delta", { sessionID: session, assistantMessageID: "msg_1", ordinal: 1, delta: "a" }))
    const done = translate(translator, event("session.execution.succeeded", { sessionID: session }))
    expect(done.map((item) => item.type)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED])
  })

  test("ignores events that are not part of the adapter contract", () => {
    expect(translate(new Translator(), event("server.connected", {})).length).toBe(0)
  })

  test("ignores TEXT_MESSAGE_END when that message was never opened", () => {
    expect(
      translate(
        new Translator(),
        event("session.text.ended", { sessionID: session, assistantMessageID: "msg_1", ordinal: 0, text: "nope" }),
      ),
    ).toEqual([])
  })

  test("prefers callID over id for tool calls", () => {
    const events = translate(
      new Translator(),
      event("session.tool.input.started", {
        sessionID: session,
        assistantMessageID: "msg_1",
        id: "internal",
        callID: "call_real",
        name: "bash",
      }),
    )
    expect(events[0]).toMatchObject({ type: EventType.TOOL_CALL_START, toolCallId: "call_real", toolCallName: "bash" })
  })

  test("uses the session id and event id when no AG-UI run is bound", () => {
    const events = translate(new Translator(), event("session.execution.started", { sessionID: "ses_9" }, "evt_9"))
    expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED, threadId: "ses_9", runId: "evt_9" })
  })

  test("emits RUN_STARTED once when the adapter already announced the run", () => {
    const translator = new Translator()
    translator.bind(session, { threadId: "thread-1", runId: "run-1", announced: true })
    expect(translate(translator, event("session.execution.started", { sessionID: session }))).toEqual([])
  })

  test("clears per-session translator state when the run finishes", () => {
    const translator = new Translator()
    translate(
      translator,
      event("session.text.delta", { sessionID: session, assistantMessageID: "msg_1", ordinal: 0, delta: "a" }),
    )
    translate(
      translator,
      event("message.part.updated", {
        sessionID: session,
        part: { id: "prt_1", sessionID: session, messageID: "msg_1", type: "tool", callID: "call_1", tool: "bash" },
      }),
    )
    expect(translator.openText.size).toBe(1)
    expect(translator.parts.size).toBe(1)
    translate(translator, event("session.execution.succeeded", { sessionID: session }))
    expect(translator.runs.size).toBe(0)
    expect(translator.openText.size).toBe(0)
    expect(translator.parts.size).toBe(0)
    expect(translator.partCall.size).toBe(0)
    expect(translator.toolSession.size).toBe(0)
  })
})

function event(type: string, data: Record<string, unknown>, id = "evt_1"): WireEvent {
  return { id, type, created: 10, data }
}

function flat(translator: Translator, ...events: WireEvent[]) {
  return events.flatMap((item) => translate(translator, item))
}
