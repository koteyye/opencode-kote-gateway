import { KoteUnsupportedTransportError, type RouteMode } from "../core/index.js"

export type TransportEnvironment = Readonly<Record<string, string | undefined>>

export function guardTransport(providerID: string, mode: RouteMode, env: TransportEnvironment = process.env) {
  if (mode !== "proxy") return
  if (!nativeTransportEnabled(env)) return
  throw new KoteUnsupportedTransportError({
    message: `KoteGateway blocked provider ${providerID}: the experimental native LLM transport cannot be proven to use the configured proxy. No direct fallback was attempted.`,
    providerID,
    mode,
  })
}

export function nativeTransportEnabled(env: TransportEnvironment = process.env) {
  return enabled(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM)
}

function enabled(value: string | undefined) {
  return value !== undefined && ["1", "true", "yes", "on", "y"].includes(value.toLowerCase())
}
