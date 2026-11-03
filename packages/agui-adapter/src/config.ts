export type AdapterConfig = {
  readonly host: string
  readonly port: number
  readonly serverUrl: string
  readonly authorization?: string
  readonly directory?: string
  readonly allowedDirectories: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly token?: string
  readonly runTimeoutMs: number
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const host = env.AGUI_HOST?.trim() || "127.0.0.1"
  const port = portFrom(env.AGUI_PORT)
  const serverUrl = (env.OPENCODE_SERVER_URL?.trim() || "http://127.0.0.1:4096").replace(/\/$/, "")
  const directory = env.OPENCODE_SERVER_DIRECTORY?.trim() || undefined
  const allowedDirectories = list(env.AGUI_ALLOWED_DIRECTORIES)
  const allowedOrigins = list(env.AGUI_ALLOWED_ORIGINS)
  const token = env.AGUI_TOKEN?.trim() || undefined
  const runTimeoutMs = timeoutFrom(env.AGUI_RUN_TIMEOUT_MS)
  const authorization = authorizationHeader(env)
  const config = {
    host,
    port,
    serverUrl,
    authorization,
    directory,
    allowedDirectories,
    allowedOrigins,
    token,
    runTimeoutMs,
  }
  if (!isLoopback(host) && !token) throw new Error("AGUI_TOKEN is required when AGUI_HOST is not a loopback address")
  return config
}

export function isLoopback(host: string) {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "")
  return value === "localhost" || value === "::1" || value.startsWith("127.")
}

/** Fields safe to print. The authorization header and URL userinfo never appear here. */
export function publicConfig(config: AdapterConfig) {
  return {
    host: config.host,
    port: config.port,
    serverUrl: redactUrl(config.serverUrl),
    directory: config.directory,
    authorization: config.authorization ? "configured" : "absent",
    token: config.token ? "configured" : "absent",
    allowedOrigins: config.allowedOrigins.length,
    runTimeoutMs: config.runTimeoutMs,
  }
}

export function publicError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "request failed"
  return message
    .replace(/Basic\s+\S+/gi, "Basic [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:password|token|authorization|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 300)
}

function authorizationHeader(env: NodeJS.ProcessEnv) {
  const configured = env.OPENCODE_SERVER_AUTHORIZATION?.trim()
  if (configured) return configured
  const password = env.OPENCODE_SERVER_PASSWORD ?? env.OPENCODE_PASSWORD
  if (!password) return
  const username = env.OPENCODE_SERVER_USERNAME?.trim() || "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function portFrom(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 4097
  if (!/^\d+$/.test(value.trim())) throw new Error("AGUI_PORT must be an integer from 0 to 65535")
  const port = Number(value)
  if (port > 65535) throw new Error("AGUI_PORT must be an integer from 0 to 65535")
  return port
}

function timeoutFrom(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 600_000
  if (!/^\d+$/.test(value.trim())) throw new Error("AGUI_RUN_TIMEOUT_MS must be a positive integer")
  const timeout = Number(value)
  if (timeout < 1) throw new Error("AGUI_RUN_TIMEOUT_MS must be a positive integer")
  return timeout
}

function list(value: string | undefined) {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function redactUrl(value: string) {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  url.username = ""
  url.password = ""
  url.search = ""
  return url.toString().replace(/\/$/, "")
}
