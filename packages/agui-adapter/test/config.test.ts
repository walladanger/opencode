import { describe, expect, test } from "bun:test"
import { configFromEnv, publicConfig, publicError } from "../src/config.js"
import { promptText } from "../src/prompt.js"
import { encodeSse } from "../src/sse.js"
import { EventType } from "@ag-ui/core"

const secret = "super-secret-value"

describe("config", () => {
  test("binds localhost and leaves auth unset by default", () => {
    const config = configFromEnv({})
    expect(config.host).toBe("127.0.0.1")
    expect(config.port).toBe(4097)
    expect(config.serverUrl).toBe("http://127.0.0.1:4096")
    expect(config.authorization).toBeUndefined()
  })

  test("builds basic auth and keeps the secret out of the public view", () => {
    const config = configFromEnv({
      AGUI_HOST: "127.0.0.1",
      AGUI_PORT: "0",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: secret,
      OPENCODE_SERVER_URL: `http://opencode:${secret}@127.0.0.1:4096/opencode?token=${secret}`,
    })
    expect(config.authorization?.startsWith("Basic ")).toBe(true)
    expect(config.authorization?.includes(secret)).toBe(false)
    const printed = JSON.stringify(publicConfig(config))
    expect(printed.includes(secret)).toBe(false)
    expect(printed.includes("opencode:super")).toBe(false)
    expect(publicConfig(config).authorization).toBe("configured")
    expect(publicConfig(config).serverUrl).toBe("http://127.0.0.1:4096/opencode")
  })

  test("scrubs credentials from error text", () => {
    expect(publicError(new Error(`Basic ${secret} rejected`))).toBe("Basic [redacted] rejected")
    expect(publicError(new Error("Bearer abc.def rejected"))).toBe("Bearer [redacted] rejected")
  })
})

describe("promptText", () => {
  test("uses the latest user message, context, and resume payload", () => {
    expect(
      promptText({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ignore" },
          { role: "user", content: [{ type: "text", text: "ship it" }, { type: "image", url: "https://example.test/a.png" }] },
        ],
        context: [{ description: "directory", value: "/work" }],
        resume: [{ interruptId: "int_1", status: "resolved", payload: { ok: true } }],
      }),
    ).toBe('ship it\n\ndirectory: /work\n\nInterrupt int_1: {"ok":true}')
  })
})

describe("encodeSse", () => {
  test("writes one AG-UI data frame", () => {
    expect(encodeSse({ type: EventType.RUN_STARTED, threadId: "thread", runId: "run" })).toBe(
      `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "thread", runId: "run" })}\n\n`,
    )
  })
})
