import { omitOptionalNulls, type Event } from "@ag-ui/core"

export function encodeSse(event: Event) {
  return `data: ${JSON.stringify(omitOptionalNulls(event, "Event"))}\n\n`
}

export const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
}
