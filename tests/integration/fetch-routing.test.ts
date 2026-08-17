import { afterEach, describe, expect, it } from "bun:test"
import { getPublicKeyAsync } from "@noble/ed25519"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createKoteGatewayClient,
  KoteProxyRequestFailedError,
  signBootstrapConfig,
  type GatewayDescriptor,
  type RouteMode,
} from "../../src/core/index.js"
import {
  OPENCODE_HTTP_FALLBACK_HEADER,
  ROUTE_HEADER,
  registerPluginInstance,
  type AdapterClient,
  type BunProxyInit,
  type PluginRegistration,
} from "../../src/opencode/index.js"

type CapturedCall = {
  readonly input: RequestInfo | URL
  readonly init: BunProxyInit | undefined
}

const originalFetch = globalThis.fetch
let registration: PluginRegistration | undefined

afterEach(() => {
  registration?.dispose()
  registration = undefined
  globalThis.fetch = originalFetch
})

describe("captured fetch routing", () => {
  it("keeps direct requests direct and never resolves bootstrap", async () => {
    const calls: CapturedCall[] = []
    globalThis.fetch = capturedFetch((input, init) => {
      calls.push({ input, init: init as BunProxyInit | undefined })
      return Promise.resolve(new Response("direct"))
    })
    registration = registerPluginInstance({ instanceID: "integration-direct" })
    let gatewayCalls = 0
    registration.activate(
      fakeClient({
        routes: { "shared-direct": "direct" },
        getGateway() {
          gatewayCalls++
          return Promise.resolve({ proxyUrl: "https://gateway.invalid" })
        },
      }),
    )

    const token = registration.issueRoute("shared-direct", "direct", "https://api.shared.test/v1")
    const response = await globalThis.fetch("https://api.shared.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Synthetic direct credential",
        [ROUTE_HEADER]: token,
        [OPENCODE_HTTP_FALLBACK_HEADER]: "true",
      },
      body: "synthetic request",
    })

    expect(await response.text()).toBe("direct")
    expect(gatewayCalls).toBe(0)
    expect(calls).toHaveLength(1)
    const call = requireCall(calls, 0)
    expect(call.init?.proxy).toBeUndefined()
    const headers = new Headers(call.init?.headers)
    expect(headers.get("authorization")).toBe("Synthetic direct credential")
    expect(headers.has(ROUTE_HEADER)).toBe(false)
    expect(headers.get(OPENCODE_HTTP_FALLBACK_HEADER)).toBe("true")
  })

  it("keeps proxy headers separate from target headers", async () => {
    const calls: CapturedCall[] = []
    globalThis.fetch = capturedFetch((input, init) => {
      calls.push({ input, init: init as BunProxyInit | undefined })
      return Promise.resolve(new Response("proxied"))
    })
    registration = registerPluginInstance({ instanceID: "integration-proxy-headers" })
    registration.activate(
      fakeClient({
        routes: { "shared-proxy": "proxy" },
        descriptor: {
          proxyUrl: "https://gateway.test",
          proxyHeaders: { "x-kote-proxy-proof": "gateway-only" },
        },
      }),
    )

    const token = registration.issueRoute("shared-proxy", "proxy", "https://api.shared.test/v1")
    await globalThis.fetch("https://api.shared.test/v1/responses", {
      headers: {
        authorization: "Synthetic provider credential",
        [ROUTE_HEADER]: token,
      },
    })

    expect(calls).toHaveLength(1)
    const call = requireCall(calls, 0)
    expect(call.init?.proxy).toEqual({
      url: "https://gateway.test",
      headers: { "x-kote-proxy-proof": "gateway-only" },
    })
    const targetHeaders = new Headers(call.init?.headers)
    expect(targetHeaders.get("authorization")).toBe("Synthetic provider credential")
    expect(targetHeaders.has("x-kote-proxy-proof")).toBe(false)
    expect(targetHeaders.has(ROUTE_HEADER)).toBe(false)
  })

  it("propagates a proxy failure with one proxied attempt and zero direct attempts", async () => {
    let proxiedAttempts = 0
    let directAttempts = 0
    globalThis.fetch = capturedFetch((_input, init) => {
      if ((init as BunProxyInit | undefined)?.proxy) {
        proxiedAttempts++
        return Promise.reject(new Error("synthetic gateway outage"))
      }
      directAttempts++
      return Promise.resolve(new Response("unexpected direct response"))
    })
    registration = registerPluginInstance({ instanceID: "integration-no-fallback" })
    registration.activate(fakeClient({ routes: { failclosed: "proxy" } }))

    const token = registration.issueRoute("failclosed", "proxy", "https://provider.test/v1")
    const failure = await globalThis
      .fetch("https://provider.test/v1/responses", { headers: { [ROUTE_HEADER]: token } })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(KoteProxyRequestFailedError)
    expect(failure).toMatchObject({ code: "KOTE_PROXY_REQUEST_FAILED", mode: "proxy" })
    expect(proxiedAttempts).toBe(1)
    expect(directAttempts).toBe(0)
  })

  it("fetches signed bootstrap through captured nextFetch without interceptor recursion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kote-integration-"))
    try {
      const now = new Date("2026-08-17T12:00:00.000Z")
      const privateKey = randomBytes(32)
      const publicKeyHex = Buffer.from(await getPublicKeyAsync(privateKey)).toString("hex")
      const bootstrap = await signBootstrapConfig(
        {
          config_version: 1,
          proxy: { url: "https://gateway.test" },
          issued_at: "2026-08-01T00:00:00.000Z",
          expires_at: "2026-09-01T00:00:00.000Z",
        },
        privateKey.toString("hex"),
      )
      const calls: CapturedCall[] = []
      globalThis.fetch = capturedFetch((input, init) => {
        calls.push({ input, init: init as BunProxyInit | undefined })
        if (requestUrl(input).origin === "https://bootstrap.test") {
          return Promise.resolve(
            Response.json(bootstrap, {
              headers: { "content-length": String(JSON.stringify(bootstrap).length) },
            }),
          )
        }
        return Promise.resolve(new Response("provider response"))
      })
      registration = registerPluginInstance({ instanceID: "integration-bootstrap" })
      const client = await createKoteGatewayClient({
        config: {
          version: 1,
          default: "proxy",
          strict: true,
          providers: { synthetic: "proxy" },
          auxiliaryOrigins: {},
        },
        fetch: registration.nextFetch,
        bootstrapUrl: "https://bootstrap.test/bootstrap.json",
        cachePath: path.join(directory, "bootstrap.json"),
        publicKeyHex,
        now: () => now,
      })
      registration.activate(client)

      const token = registration.issueRoute("synthetic", "proxy", "https://provider.test/v1")
      const response = await globalThis.fetch("https://provider.test/v1/responses", {
        headers: { [ROUTE_HEADER]: token },
      })

      expect(await response.text()).toBe("provider response")
      expect(calls).toHaveLength(2)
      const bootstrapCall = requireCall(calls, 0)
      const providerCall = requireCall(calls, 1)
      expect(requestUrl(bootstrapCall.input).origin).toBe("https://bootstrap.test")
      expect(bootstrapCall.init?.proxy).toBeUndefined()
      expect(requestUrl(providerCall.input).origin).toBe("https://provider.test")
      expect(providerCall.init?.proxy).toEqual({ url: "https://gateway.test" })
      expect(
        calls.filter((call) => requestUrl(call.input).origin === "https://provider.test" && !call.init?.proxy),
      ).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function capturedFetch(
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(run, { preconnect() {} })
}

function fakeClient(
  options: Readonly<{
    routes: Readonly<Record<string, RouteMode>>
    origins?: Readonly<Record<string, string>>
    descriptor?: GatewayDescriptor
    getGateway?: () => Promise<GatewayDescriptor>
  }>,
): AdapterClient {
  return {
    resolveRoute(providerID) {
      return options.routes[providerID] ?? "proxy"
    },
    resolveProviderByOrigin(origin) {
      return options.origins?.[origin]
    },
    getGateway: options.getGateway ?? (() => Promise.resolve(options.descriptor ?? { proxyUrl: "https://gateway.test" })),
    invalidateGateway() {},
  }
}

function requestUrl(input: RequestInfo | URL) {
  if (input instanceof Request) return new URL(input.url)
  return input instanceof URL ? input : new URL(input)
}

function requireCall(calls: readonly CapturedCall[], index: number) {
  const call = calls.at(index)
  if (!call) throw new Error(`Expected captured fetch call at index ${index}.`)
  return call
}
