import { describe, expect, test } from "bun:test"
import { parseKoteGatewayConfig } from "../../src/core/config"
import { createKoteGatewayRouting } from "../../src/core/routing"

describe("KoteGateway provider routing", () => {
  test("resolves explicit routes and falls back to the configured default", () => {
    const routing = createKoteGatewayRouting(config())
    expect(routing.resolveRoute("openai")).toBe("proxy")
    expect(routing.resolveRoute("anthropic")).toBe("direct")
    expect(routing.resolveRoute("provider-added-next-year")).toBe("proxy")
    expect(routing.resolveRoute("toString")).toBe("proxy")
  })

  test("uses providerID only, independent of API key or OAuth authorization", () => {
    const routing = createKoteGatewayRouting(config())
    const requests = [
      { providerID: "openai", authorization: "Bearer oauth-value" },
      { providerID: "openai", authorization: "Bearer api-key-value" },
      { providerID: "openai", authorization: undefined },
    ]
    expect(requests.map((request) => routing.resolveRoute(request.providerID))).toEqual(["proxy", "proxy", "proxy"])
  })

  test("keeps two provider IDs with the same base URL on different routes", () => {
    const routing = createKoteGatewayRouting(config())
    const baseURL = "https://compatible.example.test/v1"
    expect(
      [
        { providerID: "tenant-direct", baseURL },
        { providerID: "tenant-proxy", baseURL },
      ].map((provider) => routing.resolveRoute(provider.providerID)),
    ).toEqual(["direct", "proxy"])
  })

  test("does not mix routes for concurrent providers", async () => {
    const routing = createKoteGatewayRouting(config())
    const providerIDs = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? "tenant-direct" : "tenant-proxy"))
    const routes = await Promise.all(providerIDs.map(async (providerID) => routing.resolveRoute(providerID)))
    expect(routes).toEqual(providerIDs.map((providerID) => (providerID === "tenant-direct" ? "direct" : "proxy")))
  })

  test("resolves configured and built-in auxiliary origins by URL origin", () => {
    const routing = createKoteGatewayRouting(config())
    expect(routing.resolveProviderByOrigin("https://login.example.test/oauth/token?flow=refresh")).toBe("tenant-proxy")
    expect(routing.resolveProviderByOrigin("https://auth.openai.com/oauth/token")).toBe("openai")
    expect(routing.resolveProviderByOrigin("https://chatgpt.com/backend-api/codex/responses")).toBe("openai")
    expect(routing.resolveProviderByOrigin("https://unrelated.example.test/path")).toBeUndefined()
  })

  test("never associates the bootstrap endpoint with a provider", () => {
    const routing = createKoteGatewayRouting(config())
    expect(routing.resolveProviderByOrigin("https://kote-bootstrap.kotey-ye.ru/bootstrap.json")).toBeUndefined()
  })
})

function config() {
  return parseKoteGatewayConfig({
    version: 1,
    default: "proxy",
    strict: true,
    providers: {
      openai: "proxy",
      anthropic: "direct",
      "tenant-direct": "direct",
      "tenant-proxy": "proxy",
    },
    auxiliaryOrigins: {
      "tenant-proxy": ["https://login.example.test"],
    },
  })
}
