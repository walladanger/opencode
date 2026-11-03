import { contentToText } from "@ag-ui/core"

type PromptSource = {
  readonly messages?: ReadonlyArray<{ readonly role?: unknown; readonly content?: unknown }>
  readonly context?: ReadonlyArray<{ readonly description?: unknown; readonly value?: unknown }>
  readonly resume?: ReadonlyArray<{
    readonly interruptId?: unknown
    readonly status?: unknown
    readonly payload?: unknown
  }>
}

/** Text forwarded to `session.prompt`. Media parts are omitted; tools are not turned into OpenCode tools. */
export function promptText(input: PromptSource) {
  const messages = input.messages ?? []
  const user = [...messages].reverse().find((message) => message.role === "user")
  const body = user ? userText(user.content).trim() : ""
  const context = (input.context ?? [])
    .flatMap((item) => {
      if (typeof item.value !== "string" || item.value.trim().length === 0) return []
      const description = typeof item.description === "string" ? item.description.trim() : ""
      if (!description) return [item.value.trim()]
      return [`${description}: ${item.value.trim()}`]
    })
    .join("\n")
  const resume = (input.resume ?? [])
    .flatMap((entry) => {
      if (typeof entry.interruptId !== "string") return []
      if (entry.status === "cancelled") return [`Interrupt ${entry.interruptId} was cancelled.`]
      if (entry.payload === undefined) return [`Interrupt ${entry.interruptId} was resolved.`]
      return [`Interrupt ${entry.interruptId}: ${JSON.stringify(entry.payload)}`]
    })
    .join("\n")
  return [body, context, resume].filter((part) => part.length > 0).join("\n\n")
}

export function directoryFrom(forwardedProps: unknown) {
  if (!forwardedProps || typeof forwardedProps !== "object" || Array.isArray(forwardedProps)) return
  if (!("directory" in forwardedProps)) return
  if (typeof forwardedProps.directory !== "string" || forwardedProps.directory.length === 0) return
  return forwardedProps.directory
}

/** Uses a client directory only when it is the configured server directory or on the allowlist. */
export function resolveDirectory(
  forwardedProps: unknown,
  config: { readonly directory?: string; readonly allowedDirectories: readonly string[] },
) {
  const requested = directoryFrom(forwardedProps)
  if (!requested) return config.directory
  if (requested === config.directory) return requested
  if (config.allowedDirectories.includes(requested)) return requested
  return config.directory
}

export type AcceptedRun = {
  readonly threadId: string
  readonly runId: string
  readonly messages: ReadonlyArray<{ readonly role?: unknown; readonly content?: unknown }>
  readonly context?: PromptSource["context"]
  readonly resume?: PromptSource["resume"]
  readonly forwardedProps?: unknown
}

/** Accepts an AG-UI RunAgentInput body. `tools` and `context` may be omitted on the wire. */
export function acceptedRun(value: unknown): AcceptedRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  if (!("threadId" in value) || typeof value.threadId !== "string" || value.threadId.length === 0) return
  if (!("runId" in value) || typeof value.runId !== "string" || value.runId.length === 0) return
  if (!("messages" in value) || !Array.isArray(value.messages)) return
  return {
    threadId: value.threadId,
    runId: value.runId,
    messages: value.messages.flatMap((message) => {
      const loose = looseMessage(message)
      if (!loose) return []
      return [loose]
    }),
    context: "context" in value && Array.isArray(value.context) ? value.context.flatMap(looseContext) : [],
    resume: "resume" in value && Array.isArray(value.resume) ? value.resume.flatMap(looseResume) : undefined,
    forwardedProps: "forwardedProps" in value ? value.forwardedProps : undefined,
  }
}

function looseMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return {
    role: "role" in value ? value.role : undefined,
    content: "content" in value ? value.content : undefined,
  }
}

function looseContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return [
    {
      description: "description" in value ? value.description : undefined,
      value: "value" in value ? value.value : undefined,
    },
  ]
}

function looseResume(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return [
    {
      interruptId: "interruptId" in value ? value.interruptId : undefined,
      status: "status" in value ? value.status : undefined,
      payload: "payload" in value ? value.payload : undefined,
    },
  ]
}

function userText(content: unknown) {
  if (typeof content === "string") return contentToText(content)
  if (!Array.isArray(content)) return ""
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return []
    if (!("text" in part) || typeof part.text !== "string") return []
    return [{ type: "text" as const, text: part.text }]
  })
  return contentToText(parts)
}
