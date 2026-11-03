import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect } from "effect"
import { Observability } from "@opencode/util/observability"
import { configFromEnv, publicConfig, publicError } from "./config.js"
import { listen } from "./server.js"
import { openCodeApi } from "./upstream.js"

export const serve = Effect.gen(function* () {
  const config = configFromEnv()
  const context = yield* Effect.context()
  const adapter = listen({
    config,
    api: openCodeApi(config),
    run: (effect) => Effect.runPromiseWith(context)(effect),
  })
  yield* Effect.logInfo("agui adapter listening", publicConfig(config))
  yield* Effect.addFinalizer(() => Effect.sync(() => adapter.stop()))
  yield* Effect.never
})

export const program = serve.pipe(
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: "opencode-agui",
    }),
  ),
  Effect.scoped,
  Effect.catchCause((cause) => Effect.logError("agui adapter failed", { message: publicError(Cause.squash(cause)) })),
)

if (import.meta.main) NodeRuntime.runMain(program)
