import { describe, expect, it } from "bun:test"
import { MarkerRegistry, isMarkerToken } from "../../src/opencode/marker-registry.js"

describe("MarkerRegistry", () => {
  it("issues opaque cryptographically-shaped tokens and resolves their context", () => {
    const registry = new MarkerRegistry()
    const token = registry.issue({ providerID: "openai", mode: "proxy", instanceID: "project-a" })

    expect(isMarkerToken(token)).toBe(true)
    expect(token).not.toContain("openai")
    expect(token).not.toContain("project-a")
    expect(registry.lookup(token)).toMatchObject({
      providerID: "openai",
      mode: "proxy",
      instanceID: "project-a",
    })
  })

  it("issues independent tokens for parallel providers and instances", () => {
    const registry = new MarkerRegistry()
    const first = registry.issue({ providerID: "custom", mode: "direct", instanceID: "project-a" })
    const second = registry.issue({ providerID: "custom", mode: "proxy", instanceID: "project-b" })

    expect(first).not.toBe(second)
    expect(registry.lookup(first)?.instanceID).toBe("project-a")
    expect(registry.lookup(second)?.instanceID).toBe("project-b")
  })

  it("expires and cleans entries at the TTL boundary", () => {
    const clock = { now: 1_000 }
    const registry = new MarkerRegistry({ ttlMs: 50, now: () => clock.now })
    const token = registry.issue({ providerID: "openai", mode: "proxy", instanceID: "project-a" })

    clock.now = 1_049
    expect(registry.lookup(token)).toBeDefined()
    clock.now = 1_050
    expect(registry.lookup(token)).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it("evicts the oldest live marker at the configured maximum", () => {
    const registry = new MarkerRegistry({ maxSize: 2 })
    const first = registry.issue({ providerID: "one", mode: "proxy", instanceID: "project" })
    const second = registry.issue({ providerID: "two", mode: "proxy", instanceID: "project" })
    const third = registry.issue({ providerID: "three", mode: "proxy", instanceID: "project" })

    expect(registry.size).toBe(2)
    expect(registry.lookup(first)).toBeUndefined()
    expect(registry.lookup(second)?.providerID).toBe("two")
    expect(registry.lookup(third)?.providerID).toBe("three")
  })

  it("clears only markers belonging to the disposed instance", () => {
    const registry = new MarkerRegistry()
    const first = registry.issue({ providerID: "one", mode: "proxy", instanceID: "project-a" })
    const second = registry.issue({ providerID: "two", mode: "direct", instanceID: "project-b" })

    registry.clearInstance("project-a")

    expect(registry.lookup(first)).toBeUndefined()
    expect(registry.lookup(second)).toBeDefined()
  })

  it("rejects malformed and unknown tokens", () => {
    const registry = new MarkerRegistry()

    expect(registry.lookup("openai:proxy")).toBeUndefined()
    expect(registry.lookup("a".repeat(43))).toBeUndefined()
  })

  it("fails deterministically when an injected random source repeatedly collides", () => {
    const registry = new MarkerRegistry({ random: (bytes) => bytes.fill(7) })
    registry.issue({ providerID: "one", mode: "proxy", instanceID: "project" })

    expect(() => registry.issue({ providerID: "two", mode: "proxy", instanceID: "project" })).toThrow(
      "repeatedly returned duplicate tokens",
    )
  })
})
