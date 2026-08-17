import {
  KoteGlobalStateConflictError,
  KoteProviderContextMissingError,
  type RouteMode,
} from "../core/index.js"
import { addObservedOrigin } from "./auxiliary-origins.js"
import { GLOBAL_STATE, GLOBAL_STATE_VERSION } from "./constants.js"
import { createFetchInterceptor } from "./fetch-interceptor.js"
import { MarkerRegistry, type MarkerRegistryOptions } from "./marker-registry.js"
import type { AdapterClient, PluginInstanceState } from "./types.js"

export type GlobalKoteState = {
  readonly version: typeof GLOBAL_STATE_VERSION
  readonly sourceFetch: typeof globalThis.fetch
  readonly nextFetch: typeof globalThis.fetch
  readonly wrapperFetch: typeof globalThis.fetch
  readonly instances: Map<string, PluginInstanceState>
  readonly markers: MarkerRegistry
  refCount: number
}

export type PluginRegistration = {
  readonly instanceID: string
  readonly nextFetch: typeof globalThis.fetch
  activate(client: AdapterClient): void
  block(error: unknown): void
  issueRoute(providerID: string, mode: RouteMode, observedApiUrl?: string): string
  dispose(): void
}

export type RegisterPluginInstanceOptions = MarkerRegistryOptions & {
  readonly instanceID?: string
  readonly bypassOrigins?: readonly string[]
}

export function registerPluginInstance(options: RegisterPluginInstanceOptions = {}): PluginRegistration {
  const state = getOrInstallState(options)
  const instanceID = options.instanceID ?? crypto.randomUUID()
  if (state.instances.has(instanceID)) {
    throw new KoteGlobalStateConflictError({
      message: `KoteGateway plugin instance ${instanceID} is already registered.`,
    })
  }
  state.instances.set(instanceID, {
    status: "loading",
    instanceID,
    observedOrigins: new Map(),
    bypassOrigins: new Set(options.bypassOrigins?.flatMap((value) => URL.parse(value)?.origin ?? []) ?? []),
  })
  state.refCount++
  let active = true

  return {
    instanceID,
    nextFetch: state.nextFetch,
    activate(client) {
      if (!active) return
      const instance = state.instances.get(instanceID)
      if (!instance) return
      state.instances.set(instanceID, { ...instance, status: "ready", client })
    },
    block(error) {
      if (!active) return
      const instance = state.instances.get(instanceID)
      if (!instance) return
      state.instances.set(instanceID, { ...instance, status: "blocked", error })
    },
    issueRoute(providerID, mode, observedApiUrl) {
      if (!active) {
        throw new KoteProviderContextMissingError({
          message: `KoteGateway plugin instance for provider ${providerID} has already been disposed.`,
          providerID,
          mode,
        })
      }
      const instance = state.instances.get(instanceID)
      if (!instance || instance.status !== "ready") {
        if (instance?.status === "blocked") throw instance.error
        throw new KoteProviderContextMissingError({
          message: `KoteGateway plugin instance for provider ${providerID} is not ready. No direct fallback was attempted.`,
          providerID,
          mode,
        })
      }
      state.instances.set(instanceID, addObservedOrigin(instance, providerID, observedApiUrl))
      return state.markers.issue({ providerID, mode, instanceID })
    },
    dispose() {
      if (!active) return
      active = false
      state.instances.delete(instanceID)
      state.markers.clearInstance(instanceID)
      state.refCount--
      if (state.refCount !== 0) return
      if (globalThis.fetch !== state.wrapperFetch) return
      globalThis.fetch = state.sourceFetch
      Reflect.deleteProperty(globalThis, GLOBAL_STATE)
    },
  }
}

export function readGlobalState() {
  const value = Reflect.get(globalThis, GLOBAL_STATE)
  if (value === undefined) return undefined
  if (!isGlobalState(value)) {
    throw new KoteGlobalStateConflictError({
      message: "KoteGateway found an incompatible global transport state. Model requests are blocked.",
    })
  }
  return value
}

function getOrInstallState(options: MarkerRegistryOptions) {
  const existing = readGlobalState()
  if (existing) return existing

  const originalFetch = globalThis.fetch
  const nextFetch = originalFetch.bind(globalThis)
  copyFetchProperties(originalFetch, nextFetch)
  const instances = new Map<string, PluginInstanceState>()
  const markers = new MarkerRegistry(options)
  const seed = {
    version: GLOBAL_STATE_VERSION,
    sourceFetch: originalFetch,
    nextFetch,
    instances,
    markers,
    refCount: 0,
  }
  const wrapperFetch = createFetchInterceptor(seed)
  copyFetchProperties(originalFetch, wrapperFetch)
  const state: GlobalKoteState = { ...seed, wrapperFetch }
  Reflect.defineProperty(globalThis, GLOBAL_STATE, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  })
  globalThis.fetch = wrapperFetch
  return state
}

function isGlobalState(value: unknown): value is GlobalKoteState {
  if (!value || typeof value !== "object") return false
  if (!("version" in value) || value.version !== GLOBAL_STATE_VERSION) return false
  if (!("sourceFetch" in value) || typeof value.sourceFetch !== "function") return false
  if (!("nextFetch" in value) || typeof value.nextFetch !== "function") return false
  if (!("wrapperFetch" in value) || typeof value.wrapperFetch !== "function") return false
  if (!("instances" in value) || !(value.instances instanceof Map)) return false
  if (!("markers" in value) || !isMarkerRegistry(value.markers)) return false
  return "refCount" in value && typeof value.refCount === "number"
}

function isMarkerRegistry(value: unknown): value is MarkerRegistry {
  if (!value || typeof value !== "object") return false
  const registry = value as Record<string, unknown>
  return ["issue", "lookup", "cleanup", "clearInstance"].every(
    (method) => typeof registry[method] === "function",
  )
}

function copyFetchProperties(source: typeof globalThis.fetch, target: typeof globalThis.fetch) {
  Object.entries(Object.getOwnPropertyDescriptors(source)).forEach(([key, descriptor]) => {
    if (["name", "length", "prototype", "arguments", "caller"].includes(key)) return
    Reflect.defineProperty(target, key, descriptor)
  })
}
