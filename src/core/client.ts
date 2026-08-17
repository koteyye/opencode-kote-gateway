import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import {
  KOTE_BOOTSTRAP_PUBLIC_KEY_HEX,
  KOTE_BOOTSTRAP_URL,
  resolveGatewayBootstrap,
  type FetchLike,
  type GatewayDescriptor,
  type ResolvedGatewayBootstrap,
} from "./bootstrap.js"
import {
  loadKoteGatewayConfig,
  parseKoteGatewayConfig,
  resolveConfigPath,
  type ConfigPathOptions,
  type KoteEnvironment,
  type KoteGatewayConfig,
  type ResolvedKoteGatewayConfig,
} from "./config.js"
import type { RouteMode } from "./errors.js"
import { createKoteGatewayRouting } from "./routing.js"

export interface CreateKoteGatewayClientOptions extends ConfigPathOptions {
  config?: KoteGatewayConfig | undefined
  fetch?: FetchLike | undefined
  cachePath?: string | undefined
  bootstrapUrl?: string | undefined
  publicKeyHex?: string | undefined
  now?: (() => Date) | undefined
}

export interface KoteGatewayClient {
  readonly status: "ready"
  readonly config: ResolvedKoteGatewayConfig
  readonly configPath: string
  resolveRoute(providerID: string): RouteMode
  resolveProviderByOrigin(origin: string): string | undefined
  getGateway(): Promise<GatewayDescriptor>
  invalidateGateway(): void
}

export async function createKoteGatewayClient(
  options: CreateKoteGatewayClientOptions = {},
): Promise<KoteGatewayClient> {
  const loaded = options.config
    ? Object.freeze({
        config: parseKoteGatewayConfig(options.config, options.configPath, options.logger),
        configPath: resolveConfigPath(options),
      })
    : await loadKoteGatewayConfig(options)
  const routing = createKoteGatewayRouting(loaded.config)
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const cachePath = resolveCachePath(options)
  const now = options.now ?? (() => new Date())
  let cached: ResolvedGatewayBootstrap | undefined
  let inFlight: Promise<GatewayDescriptor> | undefined
  let generation = 0

  return Object.freeze({
    status: "ready" as const,
    config: loaded.config,
    configPath: loaded.configPath,
    resolveRoute: routing.resolveRoute,
    resolveProviderByOrigin: routing.resolveProviderByOrigin,
    getGateway() {
      const current = now()
      if (cached && current.getTime() < cached.usableUntil) return Promise.resolve(cached.descriptor)
      if (inFlight) return inFlight

      const startedAtGeneration = generation
      const request = resolveGatewayBootstrap({
        fetch,
        cachePath,
        bootstrapUrl: options.bootstrapUrl ?? KOTE_BOOTSTRAP_URL,
        publicKeyHex: options.publicKeyHex ?? KOTE_BOOTSTRAP_PUBLIC_KEY_HEX,
        now: current,
        logger: options.logger,
      }).then((result) => {
        if (generation === startedAtGeneration) cached = result
        return result.descriptor
      })
      inFlight = request
      void request.finally(() => {
        if (inFlight === request) inFlight = undefined
      }).catch(() => undefined)
      return request
    },
    invalidateGateway() {
      generation += 1
      cached = undefined
      inFlight = undefined
    },
  })
}

export function defaultBootstrapCachePath(
  options: Readonly<{
    env?: KoteEnvironment | undefined
    platform?: string | undefined
    homeDirectory?: string | undefined
  }> = {},
): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? homedir()
  if (platform === "win32") {
    return win32.join(
      env.LOCALAPPDATA ?? env.APPDATA ?? win32.join(homeDirectory, "AppData", "Local"),
      "KoteGateway",
      "bootstrap.json",
    )
  }
  if (platform === "darwin") {
    return posix.join(homeDirectory.replaceAll("\\", "/"), "Library", "Caches", "KoteGateway", "bootstrap.json")
  }
  return posix.join(
    env.XDG_CACHE_HOME ?? posix.join(homeDirectory.replaceAll("\\", "/"), ".cache"),
    "kote-gateway",
    "bootstrap.json",
  )
}

function resolveCachePath(options: CreateKoteGatewayClientOptions): string {
  if (!options.cachePath) {
    return defaultBootstrapCachePath({
      env: options.env,
      platform: options.platform,
      homeDirectory: options.homeDirectory,
    })
  }
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? homedir()
  const expanded = expandHome(options.cachePath, homeDirectory, platform)
  if (platform === "win32") {
    return win32.normalize(win32.isAbsolute(expanded) ? expanded : win32.resolve(options.cwd ?? process.cwd(), expanded))
  }
  return posix.normalize(posix.isAbsolute(expanded) ? expanded : posix.resolve(options.cwd ?? process.cwd(), expanded))
}

function expandHome(value: string, homeDirectory: string, platform: string): string {
  if (value === "~") return homeDirectory
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value
  if (platform === "win32") return win32.join(homeDirectory, value.slice(2))
  return posix.join(homeDirectory.replaceAll("\\", "/"), value.slice(2).replaceAll("\\", "/"))
}
