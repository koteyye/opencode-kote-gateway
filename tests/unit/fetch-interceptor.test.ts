import { describe, expect, it } from "bun:test"
import {
  KoteGatewayUnavailableError,
  type GatewayDescriptor,
  type RouteMode,
} from "../../src/core/index.js"
import { ROUTE_HEADER } from "../../src/opencode/constants.js"
import { createFetchInterceptor } from "../../src/opencode/fetch-interceptor.js"
import { MarkerRegistry } from "../../src/opencode/marker-registry.js"
import type { BunProxyInit, FetchInit, FetchInput } from "../../src/opencode/request-normalizer.js"
import type { AdapterClient, PluginInstanceState, ReadyInstance } from "../../src/opencode/types.js"

describe("fetch interceptor", () => {
  it("routes string and URL inputs while preserving their identity", async () => {
    const calls: Array<{ input: FetchInput; init: FetchInit }> = []
    const fixture = harness({
      mode: "direct",
      nextFetch: makeFetch(async (input, init) => {
        calls.push({ input, init })
        return new Response("ok")
      }),
    })
    const url = new URL("https://provider.example/v1/models")

    await fixture.fetch("https://provider.example/v1/chat", { headers: { [ROUTE_HEADER]: fixture.token } })
    await fixture.fetch(url, { headers: { [ROUTE_HEADER]: fixture.token } })

    expect(calls[0]?.input).toBe("https://provider.example/v1/chat")
    expect(calls[1]?.input).toBe(url)
  })

  it("uses Request override headers without mutating the Request", async () => {
    const calls: Array<{ input: FetchInput; init: FetchInit }> = []
    const fixture = harness({
      mode: "direct",
      nextFetch: makeFetch(async (input, init) => {
        calls.push({ input, init })
        return new Response("ok")
      }),
    })
    const request = new Request("https://provider.example/v1/chat", {
      method: "POST",
      headers: { "x-original": "request" },
      body: "payload",
    })

    await fixture.fetch(request, {
      headers: { [ROUTE_HEADER]: fixture.token, "x-override": "init" },
      signal: AbortSignal.timeout(5_000),
    })

    expect(calls[0]?.input).toBe(request)
    expect(request.headers.get("x-original")).toBe("request")
    expect(request.headers.has(ROUTE_HEADER)).toBe(false)
    const outgoing = new Headers(calls[0]?.init?.headers)
    expect(outgoing.get("x-override")).toBe("init")
    expect(outgoing.has("x-original")).toBe(false)
    expect(outgoing.has(ROUTE_HEADER)).toBe(false)
    expect(request.bodyUsed).toBe(false)
  })

  it("does not read or replace a streaming upload body", async () => {
    const calls: Array<{ input: FetchInput; init: FetchInit }> = []
    const fixture = harness({
      mode: "proxy",
      nextFetch: makeFetch(async (input, init) => {
        calls.push({ input, init })
        return new Response("ok")
      }),
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream"))
        controller.close()
      },
    })
    const request = new Request("https://provider.example/v1/upload", {
      method: "POST",
      headers: { [ROUTE_HEADER]: fixture.token },
      body,
      duplex: "half",
    } as BunFetchRequestInit)

    await fixture.fetch(request)

    expect(calls[0]?.input).toBe(request)
    expect(request.body).toBe(body)
    expect(request.bodyUsed).toBe(false)
  })

  it("preserves the caller AbortSignal and the streaming Response", async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>()
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const calls: FetchInit[] = []
    const fixture = harness({
      mode: "direct",
      nextFetch: makeFetch(async (_input, init) => {
        calls.push(init)
        return response
      }),
    })

    const result = await fixture.fetch("https://provider.example/v1/stream", {
      headers: { [ROUTE_HEADER]: fixture.token },
      signal: controller.signal,
    })

    expect(calls[0]?.signal).toBe(controller.signal)
    expect(result).toBe(response)
    expect(result.body).toBe(stream)
  })

  it("does not fetch bootstrap for a direct route", async () => {
    const fixture = harness({ mode: "direct" })

    await fixture.fetch("https://provider.example/v1/chat", { headers: { [ROUTE_HEADER]: fixture.token } })

    expect(fixture.gatewayCalls.count).toBe(0)
    expect(fixture.calls).toHaveLength(1)
    expect((fixture.calls[0]?.init as BunProxyInit | undefined)?.proxy).toBeUndefined()
  })

  it("passes Bun proxy URL and CONNECT headers separately from target headers", async () => {
    const fixture = harness({
      mode: "proxy",
      gateway: {
        proxyUrl: "https://gateway.example",
        proxyHeaders: { "Proxy-Authorization": "Basic secret", "x-kote-gateway": "edge" },
      },
    })

    await fixture.fetch("https://provider.example/v1/chat", {
      headers: {
        [ROUTE_HEADER]: fixture.token,
        Authorization: "Bearer provider-token",
        "x-api-key": "provider-key",
      },
    })

    const init = fixture.calls[0]?.init as BunProxyInit | undefined
    expect(init?.proxy).toEqual({
      url: "https://gateway.example",
      headers: { "Proxy-Authorization": "Basic secret", "x-kote-gateway": "edge" },
    })
    const targetHeaders = new Headers(init?.headers)
    expect(targetHeaders.get("authorization")).toBe("Bearer provider-token")
    expect(targetHeaders.get("x-api-key")).toBe("provider-key")
    expect(targetHeaders.has("proxy-authorization")).toBe(false)
    expect(targetHeaders.has("x-kote-gateway")).toBe(false)
    expect(targetHeaders.has(ROUTE_HEADER)).toBe(false)
  })

  it("strips Kote's OpenAI fallback header without changing the caller Headers", async () => {
    const fixture = harness({ mode: "proxy", providerID: "openai" })
    const headers = new Headers({
      [ROUTE_HEADER]: fixture.token,
      "x-opencode-title": "true",
      Authorization: "Bearer provider-token",
    })

    await fixture.fetch("https://provider.example/v1/chat", { headers })

    expect(headers.get(ROUTE_HEADER)).toBe(fixture.token)
    expect(headers.get("x-opencode-title")).toBe("true")
    const outgoing = new Headers(fixture.calls[0]?.init?.headers)
    expect(outgoing.has(ROUTE_HEADER)).toBe(false)
    expect(outgoing.has("x-opencode-title")).toBe(false)
  })

  it("preserves a custom provider's unrelated x-opencode-title header", async () => {
    const fixture = harness({ mode: "proxy" })

    await fixture.fetch("https://provider.example/v1/chat", {
      headers: { [ROUTE_HEADER]: fixture.token, "x-opencode-title": "provider-value" },
    })

    expect(new Headers(fixture.calls[0]?.init?.headers).get("x-opencode-title")).toBe("provider-value")
  })

  it("retains a marker included in AWS Authorization SignedHeaders", async () => {
    const fixture = harness({ mode: "proxy" })

    await fixture.fetch("https://provider.example/model", {
      headers: {
        [ROUTE_HEADER]: fixture.token,
        Authorization:
          "AWS4-HMAC-SHA256 Credential=test/20260817/eu/test/aws4_request, SignedHeaders=content-type;host;x-kote-route-token, Signature=00",
      },
    })

    expect(new Headers(fixture.calls[0]?.init?.headers).get(ROUTE_HEADER)).toBe(fixture.token)
  })

  it("retains a marker named by x-amz-signedheaders or a presigned URL", async () => {
    const fixture = harness({ mode: "direct" })

    await fixture.fetch("https://provider.example/model", {
      headers: { [ROUTE_HEADER]: fixture.token, "x-amz-signedheaders": `host;${ROUTE_HEADER}` },
    })
    await fixture.fetch(
      `https://provider.example/model?X-Amz-SignedHeaders=host%3B${ROUTE_HEADER}`,
      { headers: { [ROUTE_HEADER]: fixture.token } },
    )

    expect(new Headers(fixture.calls[0]?.init?.headers).get(ROUTE_HEADER)).toBe(fixture.token)
    expect(new Headers(fixture.calls[1]?.init?.headers).get(ROUTE_HEADER)).toBe(fixture.token)
  })

  it("rejects an invalid token instead of sending the request", async () => {
    const fixture = harness({ mode: "proxy" })

    const error = await fixture.fetch("https://provider.example/v1/chat", {
      headers: { [ROUTE_HEADER]: "openai:proxy" },
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_ROUTE_TOKEN_INVALID" })
    expect(fixture.calls).toHaveLength(0)
  })

  it("fails closed when a provider strips the marker from an observed API origin", async () => {
    const fixture = harness({
      mode: "proxy",
      observedOrigins: new Map([["https://provider.example", new Set(["custom"])]]),
    })

    const error = await fixture.fetch("https://provider.example/v1/chat").catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_PROVIDER_CONTEXT_MISSING" })
    expect(fixture.calls).toHaveLength(0)
    expect(fixture.gatewayCalls.count).toBe(0)
  })

  it("allows same-route auxiliary OAuth on an observed provider origin", async () => {
    const fixture = harness({
      mode: "proxy",
      observedOrigins: new Map([["https://provider.example", new Set(["custom"])]]),
      auxiliaryOrigin: "https://provider.example",
    })

    await fixture.fetch("https://provider.example/oauth/token", { method: "POST" })

    expect((fixture.calls[0]?.init as BunProxyInit | undefined)?.proxy).toEqual({
      url: "https://gateway.example",
    })
  })

  it("blocks an auxiliary origin when a stripped provider marker could select a conflicting route", async () => {
    const fixture = harness({
      mode: "proxy",
      routes: { "observed-direct": "direct", "aux-proxy": "proxy" },
      observedOrigins: new Map([["https://shared.example", new Set(["observed-direct"])]]),
      auxiliaryOrigin: "https://shared.example",
      auxiliaryProviderID: "aux-proxy",
    })

    const error = await fixture.fetch("https://shared.example/oauth/token").catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_PROVIDER_CONTEXT_MISSING" })
    expect(fixture.calls).toHaveLength(0)
  })

  it("routes explicit unmarked auxiliary requests", async () => {
    const fixture = harness({ mode: "proxy", auxiliaryOrigin: "https://auth.example" })

    await fixture.fetch("https://auth.example/oauth/token", { method: "POST" })

    expect((fixture.calls[0]?.init as BunProxyInit | undefined)?.proxy).toEqual({
      url: "https://gateway.example",
    })
  })

  it("never proxies unrelated OpenCode process traffic", async () => {
    const init = { headers: { "x-service": "mcp" } }
    const fixture = harness({ mode: "proxy" })

    await fixture.fetch("https://registry.npmjs.org/package", init)

    expect(fixture.calls[0]?.init).toBe(init)
    expect(fixture.gatewayCalls.count).toBe(0)
  })

  it("always bypasses the local OpenCode server origin even if it was observed", async () => {
    const fixture = harness({
      mode: "proxy",
      observedOrigins: new Map([["http://127.0.0.1:4096", new Set(["local-provider"])]]),
      auxiliaryOrigin: "http://127.0.0.1:4096",
      bypassOrigins: new Set(["http://127.0.0.1:4096"]),
    })

    await fixture.fetch("http://127.0.0.1:4096/log", { method: "POST" })

    expect(fixture.calls).toHaveLength(1)
    expect((fixture.calls[0]?.init as BunProxyInit | undefined)?.proxy).toBeUndefined()
    expect(fixture.gatewayCalls.count).toBe(0)
  })

  it("uses the captured fetch for bootstrap without interceptor recursion", async () => {
    const calls: Array<{ input: FetchInput; init: FetchInit }> = []
    const captured = makeFetch(async (input, init) => {
      calls.push({ input, init })
      return new Response("ok")
    })
    const fixture = harness({
      mode: "proxy",
      nextFetch: captured,
      getGateway: async () => {
        await captured("https://bootstrap.example/bootstrap.json")
        return { proxyUrl: "https://gateway.example" }
      },
    })

    await fixture.fetch("https://provider.example/v1/chat", { headers: { [ROUTE_HEADER]: fixture.token } })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toBe("https://bootstrap.example/bootstrap.json")
    expect((calls[0]?.init as BunProxyInit | undefined)?.proxy).toBeUndefined()
    expect((calls[1]?.init as BunProxyInit | undefined)?.proxy).toBeDefined()
  })

  it("does not make a direct fallback when gateway resolution fails", async () => {
    const unavailable = new KoteGatewayUnavailableError({ message: "gateway down" })
    const fixture = harness({
      mode: "proxy",
      getGateway: async () => Promise.reject(unavailable),
    })

    const error = await fixture.fetch("https://provider.example/v1/chat", {
      headers: { [ROUTE_HEADER]: fixture.token },
    }).catch((cause: unknown) => cause)

    expect(error).toBe(unavailable)
    expect(fixture.calls).toHaveLength(0)
  })

  it("invalidates bootstrap and does not retry directly after a proxy transport failure", async () => {
    const fixture = harness({
      mode: "proxy",
      nextFetch: makeFetch(async () => Promise.reject(new Error("CONNECT refused"))),
    })

    const error = await fixture.fetch("https://provider.example/v1/chat", {
      headers: { [ROUTE_HEADER]: fixture.token },
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_PROXY_REQUEST_FAILED" })
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.invalidations.count).toBe(1)
  })

  it("preserves cancellation rather than wrapping it as a proxy failure", async () => {
    const controller = new AbortController()
    const aborted = new DOMException("cancelled", "AbortError")
    const fixture = harness({
      mode: "proxy",
      nextFetch: makeFetch(async () => Promise.reject(aborted)),
    })
    controller.abort()

    const error = await fixture.fetch("https://provider.example/v1/chat", {
      headers: { [ROUTE_HEADER]: fixture.token },
      signal: controller.signal,
    }).catch((cause: unknown) => cause)

    expect(error).toBe(aborted)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.invalidations.count).toBe(0)
  })

  it("rejects non-HTTPS proxy targets before bootstrap", async () => {
    const fixture = harness({ mode: "proxy" })

    const error = await fixture.fetch("http://provider.example/v1/chat", {
      headers: { [ROUTE_HEADER]: fixture.token },
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_PROXY_REQUEST_FAILED" })
    expect(fixture.gatewayCalls.count).toBe(0)
    expect(fixture.calls).toHaveLength(0)
  })

  it("rejects a consumed Request body before contacting the gateway", async () => {
    const fixture = harness({ mode: "proxy" })
    const request = new Request("https://provider.example/v1/chat", {
      method: "POST",
      headers: { [ROUTE_HEADER]: fixture.token },
      body: "consumed",
    })
    await request.text()

    const error = await fixture.fetch(request).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_REQUEST_CLONE_FAILED" })
    expect(fixture.gatewayCalls.count).toBe(0)
    expect(fixture.calls).toHaveLength(0)
  })
})

type HarnessOptions = {
  readonly mode: RouteMode
  readonly providerID?: string
  readonly routes?: Readonly<Record<string, RouteMode>>
  readonly gateway?: GatewayDescriptor
  readonly nextFetch?: typeof globalThis.fetch
  readonly getGateway?: () => Promise<GatewayDescriptor>
  readonly auxiliaryOrigin?: string
  readonly auxiliaryProviderID?: string
  readonly observedOrigins?: ReadonlyMap<string, ReadonlySet<string>>
  readonly bypassOrigins?: ReadonlySet<string>
}

function harness(options: HarnessOptions) {
  const calls: Array<{ input: FetchInput; init: FetchInit }> = []
  const gatewayCalls = { count: 0 }
  const invalidations = { count: 0 }
  const transport = options.nextFetch ?? makeFetch(async () => new Response("ok"))
  const nextFetch = makeFetch(async (input, init) => {
    calls.push({ input, init })
    return transport(input, init)
  })
  const client: AdapterClient = {
    resolveRoute: (providerID) => options.routes?.[providerID] ?? options.mode,
    resolveProviderByOrigin: (origin) =>
      origin === options.auxiliaryOrigin ? (options.auxiliaryProviderID ?? "custom") : undefined,
    getGateway: async () => {
      gatewayCalls.count++
      if (options.getGateway) return options.getGateway()
      return options.gateway ?? { proxyUrl: "https://gateway.example" }
    },
    invalidateGateway() {
      invalidations.count++
    },
  }
  const instance: ReadyInstance = {
    status: "ready",
    instanceID: "instance",
    client,
    observedOrigins: options.observedOrigins ?? new Map(),
    ...(options.bypassOrigins === undefined ? {} : { bypassOrigins: options.bypassOrigins }),
  }
  const markers = new MarkerRegistry()
  const token = markers.issue({
    providerID: options.providerID ?? "custom",
    mode: options.mode,
    instanceID: instance.instanceID,
  })
  const instances = new Map<string, PluginInstanceState>([[instance.instanceID, instance]])

  return {
    calls,
    gatewayCalls,
    invalidations,
    token,
    fetch: createFetchInterceptor({ nextFetch, markers, instances }),
  }
}

function makeFetch(handler: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(
    async (...args: Parameters<typeof globalThis.fetch>) => handler(...args),
    { preconnect() {} },
  )
}
