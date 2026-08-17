import { OPENCODE_HTTP_FALLBACK_HEADER, ROUTE_HEADER } from "./constants.js"
import {
  KoteProviderContextMissingError,
  KoteProxyRequestFailedError,
  KoteRequestCloneFailedError,
  KoteRouteTokenInvalidError,
} from "../core/index.js"
import type { MarkerRegistry } from "./marker-registry.js"
import {
  effectiveHeaders,
  markerIsSigned,
  requestOrigin,
  requestUrl,
  withHeadersAndProxy,
  withoutInternalHeaders,
  type FetchInit,
  type FetchInput,
} from "./request-normalizer.js"
import { isBypassedOrigin, observedRouteModes, resolveAuxiliaryOrigin } from "./auxiliary-origins.js"
import type { PluginInstanceState, ReadyInstance } from "./types.js"

export type FetchInterceptorState = {
  readonly nextFetch: typeof globalThis.fetch
  readonly markers: MarkerRegistry
  readonly instances: ReadonlyMap<string, PluginInstanceState>
}

export function createFetchInterceptor(state: FetchInterceptorState): typeof globalThis.fetch {
  const interceptor = async (input: FetchInput, init?: FetchInit) => {
    const headers = effectiveHeaders(input, init)
    const token = headers.get(ROUTE_HEADER)
    const origin = requestOrigin(input)

    if (token !== null) {
      const context = state.markers.lookup(token)
      if (!context) {
        throw new KoteRouteTokenInvalidError({
          message: "KoteGateway rejected an unknown, malformed, or expired route token. No direct fallback was attempted.",
          ...(origin === undefined ? {} : { targetOrigin: origin }),
        })
      }
      const instance = state.instances.get(context.instanceID)
      if (!instance || instance.status !== "ready") {
        throw new KoteProviderContextMissingError({
          message: `KoteGateway could not resolve the active plugin instance for provider ${context.providerID}. No direct fallback was attempted.`,
          providerID: context.providerID,
          mode: context.mode,
          ...(origin === undefined ? {} : { targetOrigin: origin }),
        })
      }
      return routeRequest(
        state.nextFetch,
        instance,
        context.providerID,
        context.mode,
        input,
        init,
        headers,
        context.providerID === "openai" && context.mode === "proxy",
      )
    }

    if (origin !== undefined) {
      if (isBypassedOrigin(origin, state.instances.values())) return state.nextFetch(input, init)
      const auxiliary = resolveAuxiliaryOrigin(origin, state.instances.values())
      const observedModes = observedRouteModes(origin, state.instances.values())
      if (observedModes.size > 0 && (!auxiliary || Array.from(observedModes).some((mode) => mode !== auxiliary.mode))) {
        throw new KoteProviderContextMissingError({
          message: `KoteGateway recognized provider origin ${origin}, but its opaque route token was removed before the final fetch. No direct fallback was attempted.`,
          targetOrigin: origin,
        })
      }
      if (auxiliary) {
        return routeRequest(
          state.nextFetch,
          auxiliary.instance,
          auxiliary.providerID,
          auxiliary.mode,
          input,
          init,
          headers,
          false,
        )
      }
    }

    return state.nextFetch(input, init)
  }
  return Object.assign(interceptor, { preconnect: state.nextFetch.preconnect })
}

async function routeRequest(
  nextFetch: typeof globalThis.fetch,
  instance: ReadyInstance,
  providerID: string,
  mode: "direct" | "proxy",
  input: FetchInput,
  init: FetchInit,
  headers: Headers,
  removeHttpFallbackHeader: boolean,
) {
  const target = requestUrl(input)
  const origin = target?.origin
  const outgoingHeaders = withoutInternalHeaders(headers, markerIsSigned(headers, target), removeHttpFallbackHeader)
  const requestInit = withHeadersAndProxy(init, outgoingHeaders)
  if (mode === "direct") return nextFetch(input, requestInit)

  if (!target || target.protocol !== "https:") {
    throw new KoteProxyRequestFailedError({
      message: `KoteGateway only proxies HTTPS requests for provider ${providerID}. No direct fallback was attempted.`,
      providerID,
      mode,
      ...(origin === undefined ? {} : { targetOrigin: origin }),
    })
  }
  if (input instanceof Request && input.bodyUsed && init?.body === undefined) {
    throw new KoteRequestCloneFailedError({
      message: `KoteGateway cannot safely proxy a consumed request body for provider ${providerID}. No direct fallback was attempted.`,
      providerID,
      mode,
      targetOrigin: target.origin,
    })
  }

  const descriptor = await instance.client.getGateway()
  const proxy = {
    url: descriptor.proxyUrl,
    ...(descriptor.proxyHeaders === undefined ? {} : { headers: { ...descriptor.proxyHeaders } }),
  }
  return Promise.resolve()
    .then(() => nextFetch(input, withHeadersAndProxy(init, outgoingHeaders, proxy)))
    .then(
      (response) => response,
      (cause: unknown) => {
        if (isCancellation(cause, input, init)) throw cause
        instance.client.invalidateGateway()
        throw new KoteProxyRequestFailedError({
          message: `KoteGateway proxy request failed for provider ${providerID} at ${target.origin}. No direct fallback was attempted.`,
          providerID,
          mode,
          targetOrigin: target.origin,
          cause,
        })
      },
    )
}

function isCancellation(cause: unknown, input: FetchInput, init: FetchInit) {
  if (init?.signal?.aborted) return true
  if (input instanceof Request && input.signal.aborted) return true
  return cause instanceof Error && cause.name === "AbortError"
}

export function hasInternalHeaders(input: FetchInput, init?: FetchInit) {
  const headers = effectiveHeaders(input, init)
  return headers.has(ROUTE_HEADER) || headers.has(OPENCODE_HTTP_FALLBACK_HEADER)
}
