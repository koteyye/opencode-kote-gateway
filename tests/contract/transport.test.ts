import { afterEach, describe, expect, it } from "bun:test"
import type { GatewayDescriptor, RouteMode } from "../../src/core/index.js"
import { GLOBAL_STATE, OPENCODE_HTTP_FALLBACK_HEADER, ROUTE_HEADER } from "../../src/opencode/constants.js"
import { registerPluginInstance } from "../../src/opencode/global-state.js"
import type { BunProxyInit, FetchInit, FetchInput } from "../../src/opencode/request-normalizer.js"
import { applyProviderRouteHeaders } from "../../src/opencode/route-headers.js"
import type { AdapterClient } from "../../src/opencode/types.js"

const processFetch = globalThis.fetch
const dispose: Array<() => void> = []

afterEach(() => {
  dispose.splice(0).reverse().forEach((cleanup) => cleanup())
  Reflect.deleteProperty(globalThis, GLOBAL_STATE)
  globalThis.fetch = processFetch
})

describe("provider transport contract", () => {
  it("routes an ordinary provider fetch", async () => {
    const host = testHost()
    const provider = host.add({ routes: { ordinary: "proxy" } })

    await globalThis.fetch("https://ordinary.example/v1/chat", {
      method: "POST",
      headers: provider.headers("ordinary", "https://ordinary.example/v1"),
      body: "request",
    })

    expect(host.requests).toHaveLength(1)
    expect(objectProxyOf(host.requests[0]?.init)?.url).toBe("https://gateway.example")
  })

  it("routes a provider-specific custom fetch that delegates to global fetch", async () => {
    const host = testHost()
    const provider = host.add({ routes: { custom: "proxy" } })
    const customFetch = (input: FetchInput, init?: FetchInit) =>
      globalThis.fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-custom-fetch": "applied" },
      })

    await customFetch("https://custom.example/generate", {
      headers: provider.headers("custom", "https://custom.example"),
    })

    expect(new Headers(host.requests[0]?.init?.headers).get("x-custom-fetch")).toBe("applied")
    expect(proxyOf(host.requests[0]?.init)).toBeDefined()
  })

  it("keeps OAuth refresh, provider authorization, account header, and URL rewrite before routing", async () => {
    const host = testHost()
    const provider = host.add({
      routes: { openai: "proxy" },
      auxiliaryOrigins: { openai: ["https://auth.openai.com", "https://api.openai.com", "https://chatgpt.com"] },
    })
    const modelHeaders = provider.headers("openai", "https://api.openai.com/v1")

    await globalThis.fetch("https://auth.openai.com/oauth/token", { method: "POST" })
    const oauthProviderFetch = async (input: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      headers.set("Authorization", "Bearer test-token")
      headers.set("ChatGPT-Account-Id", "account-123")
      return globalThis.fetch(new URL("https://chatgpt.com/backend-api/codex/responses"), { ...init, headers })
    }
    await oauthProviderFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: modelHeaders,
      body: "request",
    })

    expect(host.requests).toHaveLength(2)
    expect(proxyOf(host.requests[0]?.init)).toBeDefined()
    expect(host.requests[1]?.input).toEqual(new URL("https://chatgpt.com/backend-api/codex/responses"))
    const outgoing = new Headers(host.requests[1]?.init?.headers)
    expect(outgoing.get("authorization")).toBe("Bearer test-token")
    expect(outgoing.get("chatgpt-account-id")).toBe("account-123")
    expect(outgoing.has(OPENCODE_HTTP_FALLBACK_HEADER)).toBe(false)
    expect(proxyOf(host.requests[1]?.init)).toBeDefined()
  })

  it("routes a provider URL rewrite without replacing the rewritten target", async () => {
    const host = testHost()
    const provider = host.add({ routes: { rewrite: "proxy" } })
    const rewritten = new URL("https://regional.provider.example/v2/messages")

    await globalThis.fetch(rewritten, {
      headers: provider.headers("rewrite", "https://provider.example/v1"),
    })

    expect(host.requests[0]?.input).toBe(rewritten)
    expect(proxyOf(host.requests[0]?.init)).toBeDefined()
  })

  it("preserves a SigV4-like signed marker", async () => {
    const host = testHost()
    const provider = host.add({ routes: { bedrock: "proxy" } })
    const headers = provider.headers("bedrock", "https://bedrock.example")
    headers.Authorization =
      "AWS4-HMAC-SHA256 Credential=id/20260817/region/service/aws4_request, SignedHeaders=host;x-kote-route-token, Signature=signed"

    await globalThis.fetch("https://bedrock.example/model/invoke", { method: "POST", headers })

    expect(new Headers(host.requests[0]?.init?.headers).get(ROUTE_HEADER)).toBe(headers[ROUTE_HEADER] ?? null)
  })

  it("fails closed when a provider removes unknown headers", async () => {
    const host = testHost()
    const provider = host.add({ routes: { stripping: "proxy" } })
    const headers = provider.headers("stripping", "https://stripping.example/v1")
    delete headers[ROUTE_HEADER]

    const error = await globalThis.fetch("https://stripping.example/v1/chat", { headers }).catch(
      (cause: unknown) => cause,
    )

    expect(error).toMatchObject({ code: "KOTE_PROVIDER_CONTEXT_MISSING" })
    expect(host.requests).toHaveLength(0)
  })

  it("routes a Request object without consuming its body", async () => {
    const host = testHost()
    const provider = host.add({ routes: { request: "proxy" } })
    const request = new Request("https://request.example/messages", {
      method: "POST",
      headers: provider.headers("request", "https://request.example"),
      body: "payload",
    })

    await globalThis.fetch(request)

    expect(host.requests[0]?.input).toBe(request)
    expect(request.bodyUsed).toBe(false)
  })

  it("routes a streaming upload without buffering", async () => {
    const host = testHost()
    const provider = host.add({ routes: { upload: "proxy" } })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
    const request = new Request("https://upload.example/messages", {
      method: "POST",
      headers: provider.headers("upload", "https://upload.example"),
      body,
      duplex: "half",
    } as BunFetchRequestInit)

    await globalThis.fetch(request)

    expect(host.requests[0]?.input).toBe(request)
    expect(request.body).toBe(body)
    expect(request.bodyUsed).toBe(false)
  })

  it("returns a streaming SSE response unchanged", async () => {
    const stream = new ReadableStream<Uint8Array>()
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } })
    const host = testHost({ response })
    const provider = host.add({ routes: { streaming: "proxy" } })

    const result = await globalThis.fetch("https://streaming.example/messages", {
      headers: provider.headers("streaming", "https://streaming.example"),
    })

    expect(result).toBe(response)
    expect(result.body).toBe(stream)
  })

  it("forces the OpenAI 1.18.x WebSocket wrapper onto its HTTP path for proxy mode", async () => {
    const host = testHost()
    const provider = host.add({ routes: { openai: "proxy" } })
    const headers = provider.headers("openai", "https://api.openai.com/v1")
    const webSockets = { count: 0 }
    const officialWebSocketFetch = (input: FetchInput, init?: FetchInit) => {
      const internal = new Headers(init?.headers)
      if (internal.get(OPENCODE_HTTP_FALLBACK_HEADER) !== "true") {
        webSockets.count++
        return Promise.resolve(new Response("websocket"))
      }
      internal.delete(OPENCODE_HTTP_FALLBACK_HEADER)
      return globalThis.fetch(input, { ...init, headers: internal })
    }

    await officialWebSocketFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers,
    })

    expect(webSockets.count).toBe(0)
    expect(host.requests).toHaveLength(1)
    expect(proxyOf(host.requests[0]?.init)).toBeDefined()
  })

  it("allows the native runtime only for direct routes", () => {
    const host = testHost()
    const proxy = host.add({ routes: { native: "proxy" } })
    const direct = host.add({ routes: { native: "direct" } })
    const env = { OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true" }

    expect(() => proxy.headers("native", "https://native.example", env)).toThrow(
      expect.objectContaining({ code: "KOTE_UNSUPPORTED_TRANSPORT" }),
    )
    const directHeaders = direct.headers("native", "https://native.example", env)
    expect(directHeaders).toEqual({})
    expect(host.requests).toHaveLength(0)
  })

  it("matches OpenCode's short native-runtime boolean spelling", () => {
    const host = testHost()
    const proxy = host.add({ routes: { native: "proxy" } })

    expect(() => proxy.headers("native", "https://native.example", { OPENCODE_EXPERIMENTAL_NATIVE_LLM: "y" }))
      .toThrow(expect.objectContaining({ code: "KOTE_UNSUPPORTED_TRANSPORT" }))
  })

  it("keeps concurrent provider IDs with the same base URL on their exact routes", async () => {
    const host = testHost()
    const provider = host.add({ routes: { directID: "direct", proxyID: "proxy" } })

    await Promise.all([
      globalThis.fetch("https://shared.example/v1/chat", {
        headers: { ...provider.headers("directID", "https://shared.example/v1"), "x-request": "direct" },
      }),
      globalThis.fetch("https://shared.example/v1/chat", {
        headers: { ...provider.headers("proxyID", "https://shared.example/v1"), "x-request": "proxy" },
      }),
    ])

    const direct = host.requests.find((request) => new Headers(request.init?.headers).get("x-request") === "direct")
    const proxy = host.requests.find((request) => new Headers(request.init?.headers).get("x-request") === "proxy")
    expect(proxyOf(direct?.init)).toBeUndefined()
    expect(proxyOf(proxy?.init)).toBeDefined()
  })

  it("rejects conflicting auxiliary routes across active plugin instances", async () => {
    const host = testHost()
    host.add({ routes: { first: "direct" }, auxiliaryOrigins: { first: ["https://login.example"] } })
    host.add({ routes: { second: "proxy" }, auxiliaryOrigins: { second: ["https://login.example"] } })

    const error = await globalThis.fetch("https://login.example/token").catch((cause: unknown) => cause)

    expect(error).toMatchObject({ code: "KOTE_GLOBAL_STATE_CONFLICT" })
    expect(host.requests).toHaveLength(0)
  })
})

type InstanceOptions = {
  readonly routes: Readonly<Record<string, RouteMode>>
  readonly auxiliaryOrigins?: Readonly<Record<string, readonly string[]>>
  readonly gateway?: GatewayDescriptor
}

function testHost(options: { readonly response?: Response } = {}) {
  const requests: Array<{ input: FetchInput; init: FetchInit }> = []
  globalThis.fetch = makeFetch(async (input, init) => {
    requests.push({ input, init })
    return options.response ?? new Response("ok")
  })

  return {
    requests,
    add(instanceOptions: InstanceOptions) {
      const registration = registerPluginInstance()
      dispose.push(registration.dispose)
      const client: AdapterClient = {
        resolveRoute: (providerID) => instanceOptions.routes[providerID] ?? "proxy",
        resolveProviderByOrigin(origin) {
          return Object.entries(instanceOptions.auxiliaryOrigins ?? {}).find(([, origins]) =>
            origins.includes(origin),
          )?.[0]
        },
        getGateway: async () => instanceOptions.gateway ?? {
          proxyUrl: "https://gateway.example",
          proxyHeaders: { "Proxy-Authorization": "Basic gateway-only" },
        },
        invalidateGateway() {},
      }
      registration.activate(client)
      return {
        headers(
          providerID: string,
          apiUrl?: string,
          env?: Readonly<Record<string, string | undefined>>,
        ) {
          const headers: Record<string, string> = {}
          applyProviderRouteHeaders(
            registration,
            client,
            { providerID, ...(apiUrl === undefined ? {} : { apiUrl }) },
            headers,
            env,
          )
          return headers
        },
      }
    },
  }
}

function proxyOf(init: FetchInit) {
  return (init as BunProxyInit | undefined)?.proxy
}

function objectProxyOf(init: FetchInit) {
  const proxy = proxyOf(init)
  if (!proxy || typeof proxy === "string" || proxy instanceof URL) return undefined
  return proxy
}

function makeFetch(handler: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(handler, { preconnect() {} })
}
