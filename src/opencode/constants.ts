export const GLOBAL_STATE = Symbol.for("@koteyye/kote-gateway-opencode/global-state/v1")
export const GLOBAL_STATE_VERSION = 1 as const
export const ROUTE_HEADER = "x-kote-route-token"
export const OPENCODE_HTTP_FALLBACK_HEADER = "x-opencode-title"
export const DEFAULT_MARKER_TTL_MS = 5 * 60 * 1000
export const DEFAULT_MARKER_MAX_SIZE = 4_096
