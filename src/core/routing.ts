import type { ResolvedKoteGatewayConfig } from "./config.js"
import type { RouteMode } from "./errors.js"
import { KOTE_BOOTSTRAP_ORIGIN } from "./bootstrap.js"

export interface KoteGatewayRouting {
  resolveRoute(providerID: string): RouteMode
  resolveProviderByOrigin(origin: string): string | undefined
}

export function createKoteGatewayRouting(config: ResolvedKoteGatewayConfig): KoteGatewayRouting {
  const origins = new Map<string, string>()
  Object.entries(config.auxiliaryOrigins).forEach(([providerID, providerOrigins]) => {
    providerOrigins.forEach((origin) => {
      if (!origins.has(origin)) origins.set(origin, providerID)
    })
  })

  return Object.freeze({
    resolveRoute(providerID: string) {
      return Object.hasOwn(config.providers, providerID) ? config.providers[providerID]! : config.default
    },
    resolveProviderByOrigin(origin: string) {
      const normalized = requestOrigin(origin)
      if (!normalized || normalized === KOTE_BOOTSTRAP_ORIGIN) return undefined
      return origins.get(normalized)
    },
  })
}

function requestOrigin(value: string): string | undefined {
  const url = URL.parse(value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined
  return url.origin
}
