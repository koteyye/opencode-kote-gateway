import type { RouteMode } from "../core/index.js"
import { OPENCODE_HTTP_FALLBACK_HEADER, ROUTE_HEADER } from "./constants.js"
import type { PluginRegistration } from "./global-state.js"
import { guardTransport, nativeTransportEnabled, type TransportEnvironment } from "./transport-guard.js"

export type RouteHeaderClient = {
  resolveRoute(providerID: string): RouteMode
}

export type ProviderRouteInput = {
  readonly providerID: string
  readonly apiUrl?: string
}

export function applyProviderRouteHeaders(
  registration: PluginRegistration,
  client: RouteHeaderClient,
  input: ProviderRouteInput,
  headers: Record<string, string>,
  env?: TransportEnvironment,
) {
  const mode = client.resolveRoute(input.providerID)
  guardTransport(input.providerID, mode, env)
  if (nativeTransportEnabled(env)) return mode
  headers[ROUTE_HEADER] = registration.issueRoute(input.providerID, mode, input.apiUrl)
  if (input.providerID === "openai" && mode === "proxy") headers[OPENCODE_HTTP_FALLBACK_HEADER] = "true"
  return mode
}
