import { OPENCODE_HTTP_FALLBACK_HEADER, ROUTE_HEADER } from "./constants.js"

export type FetchInput = Parameters<typeof globalThis.fetch>[0]
export type FetchInit = Parameters<typeof globalThis.fetch>[1]
export type BunProxy =
  | string
  | URL
  | {
      readonly url: string | URL
      readonly headers?: HeadersInit
    }
export type BunProxyInit = RequestInit & { readonly proxy?: BunProxy }

export function effectiveHeaders(input: FetchInput, init?: FetchInit) {
  if (init?.headers !== undefined) return new Headers(init.headers)
  if (input instanceof Request) return new Headers(input.headers)
  return new Headers()
}

export function requestUrl(input: FetchInput) {
  if (input instanceof Request) return URL.parse(input.url) ?? undefined
  if (input instanceof URL) return input
  return URL.parse(input) ?? undefined
}

export function requestOrigin(input: FetchInput) {
  return requestUrl(input)?.origin
}

export function markerIsSigned(headers: Headers, url?: URL) {
  const explicit = headers.get("x-amz-signedheaders")
  if (explicit && signedHeaders(explicit).includes(ROUTE_HEADER)) return true
  const presigned = url
    ? Array.from(url.searchParams).find(([key]) => key.toLowerCase() === "x-amz-signedheaders")?.[1]
    : undefined
  if (presigned && signedHeaders(presigned).includes(ROUTE_HEADER)) return true
  const authorization = headers.get("authorization")
  if (!authorization) return false
  const value = /(?:^|[\s,])SignedHeaders\s*=\s*([^,\s]+)/i.exec(authorization)?.[1]
  return value !== undefined && signedHeaders(value).includes(ROUTE_HEADER)
}

export function withoutInternalHeaders(headers: Headers, preserveMarker: boolean, removeHttpFallbackHeader = false) {
  const result = new Headers(headers)
  if (!preserveMarker) result.delete(ROUTE_HEADER)
  if (removeHttpFallbackHeader) result.delete(OPENCODE_HTTP_FALLBACK_HEADER)
  return result
}

export function withHeadersAndProxy(
  init: FetchInit,
  headers: Headers,
  proxy?: Exclude<BunProxy, string | URL>,
): BunProxyInit {
  return {
    ...init,
    headers,
    ...(proxy === undefined ? {} : { proxy }),
  }
}

function signedHeaders(value: string) {
  return value
    .split(/[;,]/)
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
}
