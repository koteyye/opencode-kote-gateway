import { KoteGlobalStateConflictError, type RouteMode } from "../core/index.js"
import type { AuxiliaryRoute, PluginInstanceState } from "./types.js"

export function normalizeObservedOrigin(value: string | undefined) {
  if (!value) return undefined
  const url = URL.parse(value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined
  return url.origin
}

export function resolveAuxiliaryOrigin(origin: string, instances: Iterable<PluginInstanceState>) {
  const candidates = Array.from(instances).flatMap((instance) => {
    if (instance.status !== "ready") return []
    const providerID = instance.client.resolveProviderByOrigin(origin)
    if (providerID === undefined) return []
    return [
      {
        instance,
        providerID,
        mode: instance.client.resolveRoute(providerID),
      } satisfies AuxiliaryRoute,
    ]
  })
  if (candidates.length === 0) return undefined

  const modes = new Set<RouteMode>(candidates.map((candidate) => candidate.mode))
  if (modes.size === 1) return candidates[0]
  throw new KoteGlobalStateConflictError({
    message: `KoteGateway blocked auxiliary origin ${origin}: active plugin instances assign conflicting routes. No direct fallback was attempted.`,
    targetOrigin: origin,
  })
}

export function observedRouteModes(origin: string, instances: Iterable<PluginInstanceState>) {
  return new Set(
    Array.from(instances).flatMap((instance) => {
      if (instance.status !== "ready") return []
      return Array.from(instance.observedOrigins.get(origin) ?? []).map((providerID) =>
        instance.client.resolveRoute(providerID),
      )
    }),
  )
}

export function isBypassedOrigin(origin: string, instances: Iterable<PluginInstanceState>) {
  return Array.from(instances).some((instance) => instance.bypassOrigins?.has(origin))
}

export function addObservedOrigin(instance: PluginInstanceState, providerID: string, value: string | undefined) {
  const origin = normalizeObservedOrigin(value)
  if (!origin) return instance
  const providers = new Set(instance.observedOrigins.get(origin) ?? [])
  providers.add(providerID)
  const observedOrigins = new Map(instance.observedOrigins)
  observedOrigins.set(origin, providers)
  return { ...instance, observedOrigins } as PluginInstanceState
}
