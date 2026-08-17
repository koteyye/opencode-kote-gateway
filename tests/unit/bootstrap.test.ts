import { afterEach, describe, expect, test } from "bun:test"
import { getPublicKeyAsync } from "@noble/ed25519"
import { randomBytes } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  KOTE_BOOTSTRAP_GRACE_PERIOD_MS,
  KOTE_BOOTSTRAP_MAX_BYTES,
  KOTE_BOOTSTRAP_PUBLIC_KEY_HEX,
  KOTE_BOOTSTRAP_TIMEOUT_MS,
  canonicalJson,
  fetchRemoteBootstrap,
  isBootstrapCacheUsable,
  readBootstrapCache,
  resolveGatewayBootstrap,
  signBootstrapConfig,
  signingMessage,
  verifyBootstrapConfig,
  writeBootstrapCache,
  type BootstrapConfig,
} from "../../src/core/bootstrap"
import { createKoteGatewayClient } from "../../src/core/client"
import { parseKoteGatewayConfig } from "../../src/core/config"
import {
  KoteBootstrapExpiredError,
  KoteBootstrapInvalidError,
  KoteBootstrapSignatureInvalidError,
  KoteBootstrapUnavailableError,
} from "../../src/core/errors"

const directories: string[] = []
const validNow = new Date("2026-07-15T00:00:00.000Z")

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("KoteGateway bootstrap protocol", () => {
  test("preserves the production endpoint, key, timeout, size cap, and grace period", () => {
    expect(KOTE_BOOTSTRAP_PUBLIC_KEY_HEX).toBe("d5e1f3f5353848e49e341ede50622b2d5c96bbf2817a02539c4b7e4ba0ef7bb3")
    expect(KOTE_BOOTSTRAP_PUBLIC_KEY_HEX).toMatch(/^[0-9a-f]{64}$/)
    expect(KOTE_BOOTSTRAP_TIMEOUT_MS).toBe(10_000)
    expect(KOTE_BOOTSTRAP_MAX_BYTES).toBe(64 * 1024)
    expect(KOTE_BOOTSTRAP_GRACE_PERIOD_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test("uses recursively sorted canonical JSON and excludes the signature", () => {
    expect(canonicalJson({ z: 1, a: { d: undefined, c: 2 }, list: [3, 1] })).toBe(
      '{"a":{"c":2},"list":[3,1],"z":1}',
    )
    expect(signingMessage({ ...unsigned(), signature: "secret" })).toBe(
      '{"config_version":1,"expires_at":"2026-08-01T00:00:00.000Z","issued_at":"2026-07-01T00:00:00.000Z","proxy":{"url":"https://proxy.example.test"}}',
    )
  })

  test("accepts a correctly signed config and rejects wrong, malformed, or tampered signatures", async () => {
    const fixture = await signed()
    expect(await verifyBootstrapConfig(fixture.config, { now: validNow, publicKeyHex: fixture.publicKey })).toEqual({
      ok: true,
      config: fixture.config,
    })
    expect(
      await verifyBootstrapConfig({ ...fixture.config, signature: "not-hex" }, { now: validNow, publicKeyHex: fixture.publicKey }),
    ).toMatchObject({ ok: false, error: { _tag: "BadSignature" } })
    expect(
      await verifyBootstrapConfig(
        { ...fixture.config, proxy: { url: "https://tampered.example.test" } },
        { now: validNow, publicKeyHex: fixture.publicKey },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "BadSignature" } })
    const other = await keys()
    expect(await verifyBootstrapConfig(fixture.config, { now: validNow, publicKeyHex: other.publicKey })).toMatchObject({
      ok: false,
      error: { _tag: "BadSignature" },
    })
  })

  test("rejects malformed data, unknown versions, expiry, and future issuance without clock skew", async () => {
    expect(await verifyBootstrapConfig({ invalid: true })).toMatchObject({ ok: false, error: { _tag: "Malformed" } })
    const unknown = await signed({ ...unsigned(), config_version: 2 })
    expect(await verifyBootstrapConfig(unknown.config, { now: validNow, publicKeyHex: unknown.publicKey })).toMatchObject({
      ok: false,
      error: { _tag: "UnknownConfigVersion" },
    })
    const expired = await signed(unsigned(new Date("2026-06-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z")))
    expect(await verifyBootstrapConfig(expired.config, { now: validNow, publicKeyHex: expired.publicKey })).toMatchObject({
      ok: false,
      error: { _tag: "Expired" },
    })
    const future = await signed(unsigned(new Date("2026-07-15T00:00:00.001Z"), new Date("2026-08-01T00:00:00.000Z")))
    expect(await verifyBootstrapConfig(future.config, { now: validNow, publicKeyHex: future.publicKey })).toMatchObject({
      ok: false,
      error: { _tag: "NotYetValid" },
    })
  })
})

describe("KoteGateway bootstrap transport", () => {
  test("requires HTTPS without credentials before calling fetch", async () => {
    let calls = 0
    const fetch = async () => {
      calls += 1
      return new Response("{}")
    }
    await expect(fetchRemoteBootstrap({ fetch, url: "http://bootstrap.example.test/config.json" })).rejects.toBeInstanceOf(
      KoteBootstrapInvalidError,
    )
    await expect(
      fetchRemoteBootstrap({ fetch, url: "https://user:secret@bootstrap.example.test/config.json" }),
    ).rejects.toBeInstanceOf(KoteBootstrapInvalidError)
    expect(calls).toBe(0)
  })

  test("requests JSON with redirects disabled", async () => {
    const observed: { redirect: RequestRedirect | undefined; accept: string | null } = {
      redirect: undefined,
      accept: null,
    }
    await fetchRemoteBootstrap({
      fetch: async (_input, init) => {
        observed.redirect = init?.redirect
        observed.accept = new Headers(init?.headers).get("accept")
        return new Response("{}")
      },
    })
    expect(observed.redirect).toBe("error")
    expect(observed.accept).toBe("application/json")
  })

  test("enforces content-length and streaming response caps", async () => {
    await expect(
      fetchRemoteBootstrap({
        fetch: async () => new Response("{}", { headers: { "content-length": "5" } }),
        maxBytes: 4,
      }),
    ).rejects.toThrow("content-length")

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      },
    })
    await expect(
      fetchRemoteBootstrap({ fetch: async () => new Response(body), maxBytes: 4 }),
    ).rejects.toThrow("streamed")
  })

  test("aborts the captured fetch when the timeout elapses", async () => {
    const started = performance.now()
    await expect(
      fetchRemoteBootstrap({
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
          }),
        timeoutMs: 5,
      }),
    ).rejects.toBeDefined()
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("classifies malformed remote JSON as invalid", async () => {
    await expect(
      fetchRemoteBootstrap({ fetch: async () => new Response("{ malformed") }),
    ).rejects.toBeInstanceOf(KoteBootstrapInvalidError)
  })
})

describe("KoteGateway bootstrap cache and resolution", () => {
  test("reads a signed cache in grace, rejects it after grace, and tolerates corruption", async () => {
    const fixture = await signed(unsigned(new Date("2026-06-01T00:00:00.000Z"), new Date("2026-07-12T00:00:00.000Z")))
    const cachePath = await temporaryCachePath()
    await writeBootstrapCache(fixture.config, cachePath)
    const loaded = await readBootstrapCache(cachePath, { now: validNow, publicKeyHex: fixture.publicKey })
    expect(loaded).toEqual(fixture.config)
    expect(isBootstrapCacheUsable(loaded!, validNow)).toBe(true)
    expect(isBootstrapCacheUsable(loaded!, new Date("2026-07-19T00:00:00.000Z"))).toBe(false)
    await Bun.write(cachePath, "{ corrupt")
    expect(await readBootstrapCache(cachePath, { now: validNow, publicKeyHex: fixture.publicKey })).toBeUndefined()
  })

  test("writes atomically without leaving instance temporary files", async () => {
    const fixture = await signed()
    const cachePath = await temporaryCachePath()
    await writeBootstrapCache(fixture.config, cachePath)
    expect(await Bun.file(cachePath).json()).toEqual(fixture.config)
    expect((await readdir(join(cachePath, ".."))).filter((file) => file.includes(".tmp-"))).toEqual([])
  })

  test("keeps the last known good cache when a remote signature is invalid", async () => {
    const fixture = await signed()
    const cachePath = await temporaryCachePath()
    await writeBootstrapCache(fixture.config, cachePath)
    const result = await resolveGatewayBootstrap({
      fetch: async () => jsonResponse({ ...fixture.config, signature: "ab".repeat(64) }),
      cachePath,
      now: validNow,
      publicKeyHex: fixture.publicKey,
    })
    expect(result.source).toBe("cache")
    expect(result.descriptor.proxyUrl).toBe(fixture.config.proxy.url)
    expect(await Bun.file(cachePath).json()).toEqual(fixture.config)
  })

  test("persists a verified remote config and exposes no invented proxy headers", async () => {
    const fixture = await signed()
    const cachePath = await temporaryCachePath()
    const result = await resolveGatewayBootstrap({
      fetch: async () => jsonResponse(fixture.config),
      cachePath,
      now: validNow,
      publicKeyHex: fixture.publicKey,
    })
    expect(result).toMatchObject({
      source: "remote",
      descriptor: {
        proxyUrl: "https://proxy.example.test",
        expiresAt: new Date("2026-08-01T00:00:00.000Z").getTime(),
      },
    })
    expect(result.descriptor.proxyHeaders).toBeUndefined()
    expect(await Bun.file(cachePath).json()).toEqual(fixture.config)
  })

  test("returns specific typed failures when no usable cache exists", async () => {
    const fixture = await signed()
    await expect(
      resolveGatewayBootstrap({
        fetch: async () => jsonResponse({ ...fixture.config, signature: "ab".repeat(64) }),
        cachePath: await temporaryCachePath(),
        now: validNow,
        publicKeyHex: fixture.publicKey,
      }),
    ).rejects.toBeInstanceOf(KoteBootstrapSignatureInvalidError)

    const expired = await signed(unsigned(new Date("2026-05-01T00:00:00.000Z"), new Date("2026-06-01T00:00:00.000Z")))
    await expect(
      resolveGatewayBootstrap({
        fetch: async () => jsonResponse(expired.config),
        cachePath: await temporaryCachePath(),
        now: validNow,
        publicKeyHex: expired.publicKey,
      }),
    ).rejects.toBeInstanceOf(KoteBootstrapExpiredError)

    await expect(
      resolveGatewayBootstrap({
        fetch: async () => {
          throw new Error("offline")
        },
        cachePath: await temporaryCachePath(),
      }),
    ).rejects.toBeInstanceOf(KoteBootstrapUnavailableError)
  })
})

describe("KoteGateway client bootstrap lifecycle", () => {
  test("is lazy and coalesces concurrent proxy bootstrap requests with singleflight", async () => {
    const fixture = await signed()
    let calls = 0
    const client = await createKoteGatewayClient({
      config: localConfig(),
      cachePath: await temporaryCachePath(),
      now: () => validNow,
      publicKeyHex: fixture.publicKey,
      fetch: async () => {
        calls += 1
        await Bun.sleep(10)
        return jsonResponse(fixture.config)
      },
    })
    expect(calls).toBe(0)
    const descriptors = await Promise.all(Array.from({ length: 10 }, () => client.getGateway()))
    expect(calls).toBe(1)
    expect(descriptors.every((descriptor) => descriptor.proxyUrl === fixture.config.proxy.url)).toBe(true)
  })

  test("caches in memory until expiry and invalidateGateway forces a new bootstrap", async () => {
    const fixture = await signed()
    let calls = 0
    const client = await createKoteGatewayClient({
      config: localConfig(),
      cachePath: await temporaryCachePath(),
      now: () => validNow,
      publicKeyHex: fixture.publicKey,
      fetch: async () => {
        calls += 1
        return jsonResponse(fixture.config)
      },
    })
    await client.getGateway()
    await client.getGateway()
    expect(calls).toBe(1)
    client.invalidateGateway()
    await client.getGateway()
    expect(calls).toBe(2)
  })

  test("tries the remote again when a fresh in-memory descriptor expires, then uses disk grace", async () => {
    const fixture = await signed(unsigned(validNow, new Date("2026-07-16T00:00:00.000Z")))
    let current = validNow
    let calls = 0
    const client = await createKoteGatewayClient({
      config: localConfig(),
      cachePath: await temporaryCachePath(),
      now: () => current,
      publicKeyHex: fixture.publicKey,
      fetch: async () => {
        calls += 1
        if (calls === 1) return jsonResponse(fixture.config)
        throw new Error("offline")
      },
    })
    await client.getGateway()
    current = new Date("2026-07-17T00:00:00.000Z")
    expect((await client.getGateway()).proxyUrl).toBe(fixture.config.proxy.url)
    expect(calls).toBe(2)
  })

  test("uses exactly the injected fetch and performs no retry or direct fallback", async () => {
    let calls = 0
    const client = await createKoteGatewayClient({
      config: localConfig(),
      cachePath: await temporaryCachePath(),
      fetch: async () => {
        calls += 1
        throw new Error("gateway bootstrap offline")
      },
    })
    await expect(client.getGateway()).rejects.toBeInstanceOf(KoteBootstrapUnavailableError)
    expect(calls).toBe(1)
  })
})

function unsigned(
  issuedAt = new Date("2026-07-01T00:00:00.000Z"),
  expiresAt = new Date("2026-08-01T00:00:00.000Z"),
): Omit<BootstrapConfig, "signature"> {
  return {
    config_version: 1,
    proxy: { url: "https://proxy.example.test" },
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  }
}

async function keys() {
  const privateKey = randomBytes(32)
  return {
    privateKey: privateKey.toString("hex"),
    publicKey: Buffer.from(await getPublicKeyAsync(privateKey)).toString("hex"),
  }
}

async function signed(input: Omit<BootstrapConfig, "signature"> = unsigned()) {
  const pair = await keys()
  return {
    config: await signBootstrapConfig(input, pair.privateKey),
    publicKey: pair.publicKey,
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}

function localConfig() {
  return parseKoteGatewayConfig({
    version: 1,
    default: "proxy",
    strict: true,
    providers: {},
    auxiliaryOrigins: {},
  })
}

async function temporaryCachePath() {
  const directory = await mkdtemp(join(tmpdir(), "kote-gateway-bootstrap-"))
  directories.push(directory)
  return join(directory, "bootstrap.json")
}
