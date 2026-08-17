import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { RouteMode } from "../../src/core/index.js"
import { GLOBAL_STATE } from "../../src/opencode/constants.js"
import { registerPluginInstance, readGlobalState } from "../../src/opencode/global-state.js"
import type { AdapterClient } from "../../src/opencode/types.js"

const processFetch = globalThis.fetch

beforeEach(resetGlobalTransport)
afterEach(resetGlobalTransport)

describe("global KoteGateway transport state", () => {
  it("installs exactly one patch and tracks references", () => {
    const first = registerPluginInstance({ instanceID: "project-a" })
    const wrapper = globalThis.fetch
    const second = registerPluginInstance({ instanceID: "project-b" })
    const state = readGlobalState()

    expect(globalThis.fetch).toBe(wrapper)
    expect(state?.refCount).toBe(2)
    expect(state?.instances.size).toBe(2)

    first.dispose()
    expect(globalThis.fetch).toBe(wrapper)
    expect(readGlobalState()?.refCount).toBe(1)

    second.dispose()
    expect(globalThis.fetch).toBe(processFetch)
    expect(readGlobalState()).toBeUndefined()
  })

  it("keeps dispose idempotent", () => {
    const registration = registerPluginInstance()

    registration.dispose()
    registration.dispose()

    expect(globalThis.fetch).toBe(processFetch)
    expect(readGlobalState()).toBeUndefined()
  })

  it("keeps provider contexts isolated by instance", () => {
    const direct = registerPluginInstance({ instanceID: "direct-project" })
    const proxy = registerPluginInstance({ instanceID: "proxy-project" })
    direct.activate(fakeClient({ shared: "direct" }))
    proxy.activate(fakeClient({ shared: "proxy" }))

    const directToken = direct.issueRoute("shared", "direct", "https://shared.example/v1")
    const proxyToken = proxy.issueRoute("shared", "proxy", "https://shared.example/v1")

    expect(readGlobalState()?.markers.lookup(directToken)).toMatchObject({
      instanceID: "direct-project",
      mode: "direct",
    })
    expect(readGlobalState()?.markers.lookup(proxyToken)).toMatchObject({
      instanceID: "proxy-project",
      mode: "proxy",
    })

    direct.dispose()
    proxy.dispose()
  })

  it("keeps a blocked instance registered so its chat hook fails closed", () => {
    const registration = registerPluginInstance()
    const configError = new Error("invalid config")
    registration.block(configError)

    expect(() => registration.issueRoute("openai", "proxy")).toThrow(configError)

    registration.dispose()
  })

  it("composes with the fetch wrapper present before installation and preserves preconnect", async () => {
    const calls: string[] = []
    const preconnect = () => calls.push("preconnect")
    const wrapperA = Object.assign(
      makeFetch(async () => {
        calls.push("fetch")
        return new Response("ok")
      }),
      { preconnect },
    )
    globalThis.fetch = wrapperA

    const registration = registerPluginInstance()
    expect(globalThis.fetch.preconnect).toBe(preconnect)
    await globalThis.fetch("https://unrelated.example")
    expect(calls).toEqual(["fetch"])

    registration.dispose()
    expect(globalThis.fetch).toBe(wrapperA)
  })

  it("does not overwrite a wrapper installed after KoteGateway during dispose", async () => {
    const calls: string[] = []
    globalThis.fetch = makeFetch(async () => {
      calls.push("wrapper-a")
      return new Response("ok")
    })
    const registration = registerPluginInstance()
    const koteFetch = globalThis.fetch
    const wrapperB = makeFetch(async (...args) => {
      calls.push("wrapper-b")
      return koteFetch(...args)
    })
    globalThis.fetch = wrapperB

    registration.dispose()

    expect(globalThis.fetch).toBe(wrapperB)
    expect(readGlobalState()?.refCount).toBe(0)
    await globalThis.fetch("https://unrelated.example")
    expect(calls).toEqual(["wrapper-b", "wrapper-a"])
  })

  it("reports an incompatible versioned global state", () => {
    Reflect.defineProperty(globalThis, GLOBAL_STATE, {
      configurable: true,
      value: { version: 2 },
    })

    expect(() => registerPluginInstance()).toThrow(
      expect.objectContaining({ code: "KOTE_GLOBAL_STATE_CONFLICT" }),
    )
  })
})

function fakeClient(routes: Readonly<Record<string, RouteMode>> = {}): AdapterClient {
  return {
    resolveRoute: (providerID) => routes[providerID] ?? "proxy",
    resolveProviderByOrigin: () => undefined,
    getGateway: async () => ({ proxyUrl: "https://gateway.example" }),
    invalidateGateway() {},
  }
}

function makeFetch(handler: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(handler, { preconnect() {} })
}

function resetGlobalTransport() {
  Reflect.deleteProperty(globalThis, GLOBAL_STATE)
  globalThis.fetch = processFetch
}
