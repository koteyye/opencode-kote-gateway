import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUILTIN_AUXILIARY_ORIGINS,
  defaultConfigPath,
  loadKoteGatewayConfig,
  parseKoteGatewayConfig,
  resolveConfigPath,
  type KoteGatewayConfig,
} from "../../src/core/config"
import { KoteConfigInvalidError, KoteConfigNotFoundError } from "../../src/core/errors"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("KoteGateway configuration", () => {
  test("loads a valid file and returns an immutable normalized configuration", async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, "config.json")
    await Bun.write(
      configPath,
      JSON.stringify({
        version: 1,
        default: "proxy",
        strict: true,
        providers: { openai: "proxy", anthropic: "direct" },
        auxiliaryOrigins: { custom: ["https://login.example.test:443/"] },
      }),
    )

    const loaded = await loadKoteGatewayConfig({ configPath, env: {} })
    expect(loaded.config.providers.anthropic).toBe("direct")
    expect(loaded.config.auxiliaryOrigins.custom).toEqual(["https://login.example.test"])
    expect(loaded.config.auxiliaryOrigins.openai).toEqual(BUILTIN_AUXILIARY_ORIGINS.openai)
    expect(Object.isFrozen(loaded.config)).toBe(true)
    expect(Object.isFrozen(loaded.config.providers)).toBe(true)
    expect(Object.isFrozen(loaded.config.auxiliaryOrigins.custom)).toBe(true)
  })

  test("reports a missing file with its resolved path", async () => {
    const configPath = join(await temporaryDirectory(), "missing.json")
    const result = await loadKoteGatewayConfig({ configPath, env: {} }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(KoteConfigNotFoundError)
    expect(result).toMatchObject({ code: "KOTE_CONFIG_NOT_FOUND", configPath })
  })

  test("reports invalid JSON as a typed configuration error", async () => {
    const configPath = join(await temporaryDirectory(), "config.json")
    await Bun.write(configPath, "{ invalid")
    const result = await loadKoteGatewayConfig({ configPath, env: {} }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(KoteConfigInvalidError)
    expect(result).toMatchObject({ code: "KOTE_CONFIG_INVALID", configPath })
  })

  test("rejects unknown versions and invalid defaults", () => {
    expect(() => parseKoteGatewayConfig({ ...validConfig(), version: 2 })).toThrow("version must be 1")
    expect(() => parseKoteGatewayConfig({ ...validConfig(), default: "sometimes" })).toThrow(
      '"default" must be "direct" or "proxy"',
    )
  })

  test("rejects invalid provider routes and empty provider IDs", () => {
    expect(() => parseKoteGatewayConfig({ ...validConfig(), providers: { future: "sometimes" } })).toThrow(
      "route for provider",
    )
    expect(() => parseKoteGatewayConfig({ ...validConfig(), providers: { "  ": "proxy" } })).toThrow(
      "must not be empty",
    )
  })

  test("rejects auxiliary origins with paths, credentials, or the bootstrap origin", () => {
    expect(() =>
      parseKoteGatewayConfig({
        ...validConfig(),
        auxiliaryOrigins: { future: ["https://login.example.test/token"] },
      }),
    ).toThrow("must not contain a path")
    const credentialError = expectFailure(() =>
      parseKoteGatewayConfig({
        ...validConfig(),
        auxiliaryOrigins: { future: ["https://user:secret@login.example.test"] },
      }),
    )
    expect(credentialError.message).toContain("must not contain credentials")
    expect(credentialError.message).not.toContain("user")
    expect(credentialError.message).not.toContain("secret")
    expect(() =>
      parseKoteGatewayConfig({
        ...validConfig(),
        auxiliaryOrigins: { future: ["https://kote-bootstrap.kotey-ye.ru"] },
      }),
    ).toThrow("bootstrap origin")
  })

  test("rejects one auxiliary origin assigned to conflicting routes", () => {
    expect(() =>
      parseKoteGatewayConfig({
        ...validConfig(),
        providers: { first: "proxy", second: "direct" },
        auxiliaryOrigins: {
          first: ["https://login.example.test"],
          second: ["https://login.example.test/"],
        },
      }),
    ).toThrow("conflicting routes")
  })

  test("strict mode rejects unknown fields while non-strict mode warns and ignores them", () => {
    expect(() => parseKoteGatewayConfig({ ...validConfig(), extra: true })).toThrow("unknown field")
    const warnings: string[] = []
    const config = parseKoteGatewayConfig(
      { ...validConfig(), strict: false, extra: true },
      undefined,
      { warn: (message) => warnings.push(message) },
    )
    expect(config.default).toBe("proxy")
    expect(warnings).toEqual(["KoteGateway configuration contains ignored unknown fields."])
  })

  test("gives KOTE_GATEWAY_CONFIG priority over the plugin option", () => {
    const debug: string[] = []
    expect(
      resolveConfigPath({
        env: { KOTE_GATEWAY_CONFIG: "./environment.json" },
        configPath: "./option.json",
        platform: "linux",
        cwd: "/workspace",
        homeDirectory: "/home/ada",
        logger: { debug: (message) => debug.push(message) },
      }),
    ).toBe("/workspace/environment.json")
    expect(debug).toEqual(["KOTE_GATEWAY_CONFIG overrides the plugin configPath option."])
  })

  test("expands home paths and selects platform-specific defaults", () => {
    expect(
      resolveConfigPath({
        configPath: "~/.private/kote.json",
        env: {},
        platform: "linux",
        homeDirectory: "/home/ada",
        cwd: "/workspace",
      }),
    ).toBe("/home/ada/.private/kote.json")
    expect(defaultConfigPath({ env: {}, platform: "linux", homeDirectory: "/home/ada" })).toBe(
      "/home/ada/.config/kote-gateway/config.json",
    )
    expect(
      defaultConfigPath({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", homeDirectory: "/home/ada" }),
    ).toBe("/xdg/kote-gateway/config.json")
    expect(defaultConfigPath({ env: {}, platform: "darwin", homeDirectory: "/Users/ada" })).toBe(
      "/Users/ada/.config/kote-gateway/config.json",
    )
    expect(
      defaultConfigPath({
        env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
        platform: "win32",
        homeDirectory: "C:\\Users\\Ada",
      }),
    ).toBe("C:\\Users\\Ada\\AppData\\Roaming\\KoteGateway\\config.json")
  })

  test("accepts arbitrary future provider IDs and applies the default route", () => {
    const config = parseKoteGatewayConfig({
      ...validConfig(),
      default: "direct",
      providers: { "vendor-next/custom": "proxy" },
    })
    expect(config.providers["vendor-next/custom"]).toBe("proxy")
    expect(config.default).toBe("direct")
  })
})

function expectFailure(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("Expected the operation to fail.")
}

function validConfig(): KoteGatewayConfig {
  return {
    version: 1,
    default: "proxy",
    strict: true,
    providers: {},
    auxiliaryOrigins: {},
  }
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "kote-gateway-config-"))
  directories.push(directory)
  return directory
}
