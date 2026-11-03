import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "OpenCode (Warwick) Dev",
  beta: "OpenCode (Warwick) Beta",
  prod: "OpenCode (Warwick)",
}

const appIDs: Record<string, string> = {
  dev: "com.walladanger.opencode.dev",
  beta: "com.walladanger.opencode.beta",
  prod: "com.walladanger.opencode",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "OpenCode (Warwick) Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "com.walladanger.opencode.dev"
