# `@opencode/agui-adapter`

A localhost bridge from an OpenCode server to the [AG-UI protocol](https://docs.ag-ui.com).

The adapter subscribes to the server's `GET /api/event` stream and re-emits [AG-UI](https://github.com/ag-ui-protocol/ag-ui) events (`@ag-ui/core` 1.0) on its own SSE response. `POST /` accepts an AG-UI `RunAgentInput` and forwards the latest user text through the generated client in `@opencode/client` (`session.prompt`).

This package is additive. It does not change the OpenCode protocol.

## Run

From this directory:

```sh
OPENCODE_SERVER_URL=http://127.0.0.1:4096 \
OPENCODE_SERVER_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
bun ./src/cli.ts
```

The process listens on `127.0.0.1:4097` unless configured otherwise. Point an `@ag-ui/client` `HttpAgent` at `http://127.0.0.1:4097/`.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/` and `/agent` | Accept `RunAgentInput`, admit `session.prompt`, stream AG-UI events for that run until `RUN_FINISHED` or `RUN_ERROR`. |
| `GET` | `/events` | Multiplexed AG-UI stream for every translated OpenCode event. |
| `GET` | `/health` | Liveness. Reports host and port only. |

`RunAgentInput.threadId` is the AG-UI thread. When it is an OpenCode session id (`ses_…`) the adapter reuses that session; otherwise it creates one. A second `POST` for a thread that already has an active run returns 409. The session map keeps at most 256 threads.

`forwardedProps.directory` is sent as `x-opencode-directory` only when it equals `OPENCODE_SERVER_DIRECTORY` or is listed in `AGUI_ALLOWED_DIRECTORIES`. Any other value is ignored and the configured server directory is used instead.

The adapter emits `RUN_STARTED` once when it accepts the `POST`. A later `session.execution.started` for that same bound run is not emitted again. If `session.execution.started` arrives with no AG-UI run bound to the session, `threadId` is the OpenCode session id and `runId` is the OpenCode event id (`evt_…`), or `run_${sessionID}` when the event has no id.

Client disconnect and run timeout call `session.interrupt`. A broken upstream subscription emits `RUN_ERROR` (`agui.disconnected`) for every open run and reconnects with exponential backoff. A client that stops reading is dropped at the stream high-water mark so it cannot stall the upstream subscription.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGUI_HOST` | `127.0.0.1` | Bind address. A non-loopback host refuses to start unless `AGUI_TOKEN` is set. |
| `AGUI_PORT` | `4097` | Bind port. `0` asks the OS for a port. |
| `AGUI_TOKEN` | unset | Bearer token required on every request when set. Never logged. |
| `AGUI_ALLOWED_ORIGINS` | unset | Comma-separated browser origins. A request with any other `Origin` is rejected. No `Access-Control-Allow-Origin` is sent unless the request's origin is on this list, and the value is that origin rather than `*`. |
| `AGUI_ALLOWED_DIRECTORIES` | unset | Comma-separated directories a run may select via `forwardedProps.directory`. Anything else is ignored. |
| `AGUI_RUN_TIMEOUT_MS` | `600000` | How long a `POST` stream waits for a terminal OpenCode execution. On timeout the adapter interrupts the session. |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | OpenCode server origin. |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic-auth user when a password is set. |
| `OPENCODE_SERVER_PASSWORD` or `OPENCODE_PASSWORD` | unset | Basic-auth password. Sent as `Authorization` and never logged. |
| `OPENCODE_SERVER_AUTHORIZATION` | unset | Full `Authorization` header. Wins over the username and password. |
| `OPENCODE_SERVER_DIRECTORY` | unset | Default `x-opencode-directory` for prompts. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP base URL. Traces and logs are exported only when this is set. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Exporter headers. See below. |

Startup logs the redacted config from `publicConfig`: URL userinfo and query strings are removed, and the authorization value is replaced with `configured` or `absent`.

## Event mapping

The current public stream (`packages/protocol/src/groups/event.ts`, fed by `packages/server/src/handlers/event.ts`) emits v2 session events. `message.part.*` and `session.error` are v1 events and are not on that manifest. The mapper still translates them when a server sends them.

| OpenCode event | AG-UI event |
| --- | --- |
| `session.execution.started` | `RUN_STARTED` only when this run was not already announced by `POST`. `threadId` / `runId` are the bound AG-UI ids, or the unbound pair described above. |
| `session.execution.succeeded` | `RUN_FINISHED` with outcome `success` |
| `session.execution.interrupted` | `RUN_FINISHED` with outcome `cancelled` |
| `session.execution.failed`, `session.error` | `RUN_ERROR` |
| `session.text.started` / `delta` / `ended` | `TEXT_MESSAGE_START` / `CONTENT` / `END` |
| `session.reasoning.*` | `REASONING_MESSAGE_START` / `CONTENT` / `END` |
| `session.tool.input.started` / `delta` / `ended` | `TOOL_CALL_START` / `ARGS` / `END` |
| `session.tool.success`, `session.tool.failed` | `TOOL_CALL_RESULT` |
| `session.step.started`, `session.step.ended` | `STEP_STARTED`, `STEP_FINISHED` |
| `message.part.delta` with a text part, or `field: "text"` | `TEXT_MESSAGE_START` on the first delta, then `CONTENT`. `END` follows `message.part.updated` once `part.time.end` is set, or the next terminal run event. |
| `message.part.delta` with a tool part, or a `state` / `input` field | `TOOL_CALL_START` / `ARGS` / `END`, then `TOOL_CALL_RESULT` when the tool part completes |
| `session.instructions.updated` | `STATE_DELTA` (RFC 6902 replace/remove under `/sessions/{id}/instructions`) |
| `*.updated`, `session.status`, `session.idle`, `message.updated`, `message.part.updated`, `message.part.removed`, `session.diff`, `session.tool.progress`, `session.step.failed`, `session.retry.scheduled` | `STATE_SNAPSHOT` of `{ type, data }` |

`server.connected`, heartbeats, and events outside this table are dropped. A `POST` stream only forwards batches for its OpenCode session. `GET /events` forwards every batch.

Spans use `Observability.layer` from `packages/util/src/observability.ts` (`@effect/opentelemetry`). The process installs that layer, and each translation or prompt admission runs on its runtime:

| Span | When |
| --- | --- |
| `agui.run` | The whole admitted run: prompt, wait, and interrupt on failure. Attributes: `agui.thread_id`, `agui.run_id`, `opencode.session_id`. |
| `agui.subscribe` | Held open for the process. Translations are span events named `agui.translate` (`opencode.event`), sampled to every 32nd event plus execution and `session.error` events. |
| `agui.subscribe` (child, on failure) | The upstream stream dropped. The log attribute is a redacted message. The adapter then sleeps with exponential backoff on the same runtime and reconnects. |

Prompt text, authorization, and exporter headers are not span attributes.

## OpenTelemetry export

The adapter and the OpenCode server both call `Observability.layer` with `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`. Leave the endpoint unset and nothing is exported. Set it to the collector base URL; the layer posts traces to `{endpoint}/v1/traces` and logs to `{endpoint}/v1/logs`.

Header format is the one `packages/util/src/observability/otlp.ts` parses: comma-separated `key=value` pairs. Values may contain `=`. Do not log this variable.

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20collector-token \
bun ./src/cli.ts
```

### Desktop sidecar

The desktop app's sidecar is the OpenCode server, not a second process inside Electron. `packages/desktop/src/main/service/background-service.ts` starts `opencode serve --service`. `packages/client/src/service-contender.ts` spawns that process with `env: { ...process.env, ...env }`, so the desktop process environment is inherited. `packages/cli/src/index.ts` already installs `Observability.layer` from the same two variables.

Launch the desktop app with those variables set and the sidecar exports OTLP. No desktop source change is required for that.

Electron main-process tracing is not wired. `@opencode/desktop` does not depend on `@opencode/util`, and installing the OpenTelemetry SDK into the Electron main bundle is more than an isolated call-site change. The sidecar, which serves `/api/event`, is the process that already honors the variables above.

## What is not forwarded

- `RunAgentInput.tools` is accepted and ignored. OpenCode keeps its own tool registry; these definitions are not registered or sent as provider tools.
- Resume entries are appended to the prompt text. OpenCode has no AG-UI interrupt channel.
- User message parts other than text are omitted from the prompt. `contentToText` from `@ag-ui/core` is used for the text parts.
- Tool file results become a single `[file] {uri}` line inside `TOOL_CALL_RESULT`.
- Client disconnect and run timeout call `session.interrupt` for that session.

## Tests

```sh
bun test
bun run typecheck
```

Run both from `packages/agui-adapter`. The repository test guard rejects `bun test` from the repo root.
