import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { KOTE_BOOTSTRAP_ORIGIN } from "./bootstrap.js"
import { KoteConfigInvalidError, KoteConfigNotFoundError, type RouteMode } from "./errors.js"
import type { KoteGatewayLoggerInput } from "./logging.js"

export const KOTE_CONFIG_VERSION = 1 as const
export const KOTE_CONFIG_ENVIRONMENT_VARIABLE = "KOTE_GATEWAY_CONFIG" as const

export const BUILTIN_AUXILIARY_ORIGINS = Object.freeze({
  openai: Object.freeze(["https://auth.openai.com", "https://api.openai.com", "https://chatgpt.com"]),
}) satisfies Readonly<Record<string, readonly string[]>>

export type KoteGatewayConfig = Readonly<{
  version: 1
  default: RouteMode
  /** Reject unknown top-level configuration fields when true; routing remains fail-closed in either mode. */
  strict: boolean
  providers: Readonly<Record<string, RouteMode>>
  auxiliaryOrigins?: Readonly<Record<string, readonly string[]>> | undefined
}>

export type ResolvedKoteGatewayConfig = Omit<KoteGatewayConfig, "auxiliaryOrigins"> &
  Readonly<{ auxiliaryOrigins: Readonly<Record<string, readonly string[]>> }>

export type KoteEnvironment = Readonly<Record<string, string | undefined>>

export interface ConfigPathOptions {
  configPath?: string | undefined
  env?: KoteEnvironment | undefined
  platform?: string | undefined
  homeDirectory?: string | undefined
  cwd?: string | undefined
  logger?: KoteGatewayLoggerInput | undefined
}

export type LoadedKoteGatewayConfig = Readonly<{
  config: ResolvedKoteGatewayConfig
  configPath: string
}>

const CONFIG_FIELDS = new Set(["version", "default", "strict", "providers", "auxiliaryOrigins"])

export function parseKoteGatewayConfig(
  raw: unknown,
  configPath?: string,
  logger?: KoteGatewayLoggerInput,
): ResolvedKoteGatewayConfig {
  const input = requireRecord(raw, "configuration", configPath)
  if (typeof input.strict !== "boolean") throw invalid('KoteGateway "strict" must be a boolean.', configPath)
  const unknownFields = Object.keys(input).filter((field) => !CONFIG_FIELDS.has(field))
  if (unknownFields.length > 0 && input.strict) {
    throw invalid(`KoteGateway configuration contains unknown field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}.`, configPath)
  }
  if (unknownFields.length > 0) {
    logger?.warn?.("KoteGateway configuration contains ignored unknown fields.", { fields: unknownFields })
  }
  if (input.version !== KOTE_CONFIG_VERSION) {
    throw invalid(`KoteGateway configuration version must be ${KOTE_CONFIG_VERSION}.`, configPath)
  }
  if (!isRouteMode(input.default)) throw invalid('KoteGateway "default" must be "direct" or "proxy".', configPath)
  const defaultRoute = input.default

  const providersInput = requireRecord(input.providers, "providers", configPath)
  const providers: Record<string, RouteMode> = Object.fromEntries(
    Object.entries(providersInput).map(([providerID, mode]) => {
      if (providerID.trim() === "") throw invalid("KoteGateway provider IDs must not be empty.", configPath)
      if (!isRouteMode(mode)) {
        throw invalid(`KoteGateway route for provider ${JSON.stringify(providerID)} must be "direct" or "proxy".`, configPath)
      }
      return [providerID, mode] as const
    }),
  )

  const configuredOrigins = input.auxiliaryOrigins === undefined
    ? {}
    : requireRecord(input.auxiliaryOrigins, "auxiliaryOrigins", configPath)
  const auxiliaryOrigins = new Map<string, string[]>(
    Object.entries(BUILTIN_AUXILIARY_ORIGINS).map(([providerID, origins]) => [providerID, [...origins]]),
  )

  Object.entries(configuredOrigins).forEach(([providerID, origins]) => {
    if (providerID.trim() === "") throw invalid("KoteGateway auxiliary origin provider IDs must not be empty.", configPath)
    if (!Array.isArray(origins)) {
      throw invalid(`KoteGateway auxiliary origins for provider ${JSON.stringify(providerID)} must be an array.`, configPath)
    }
    const existing = auxiliaryOrigins.get(providerID) ?? []
    const normalized = origins.map((origin) => normalizeAuxiliaryOrigin(origin, providerID, configPath))
    auxiliaryOrigins.set(providerID, [...new Set([...existing, ...normalized])])
  })

  const originOwners = new Map<string, { providerID: string; mode: RouteMode }>()
  auxiliaryOrigins.forEach((origins, providerID) => {
    const mode = Object.hasOwn(providers, providerID) ? providers[providerID]! : defaultRoute
    origins.forEach((origin) => {
      const existing = originOwners.get(origin)
      if (existing && existing.mode !== mode) {
        throw invalid(
          `KoteGateway auxiliary origin ${origin} has conflicting routes for providers ${JSON.stringify(existing.providerID)} and ${JSON.stringify(providerID)}.`,
          configPath,
        )
      }
      if (!existing) originOwners.set(origin, { providerID, mode })
    })
  })

  return Object.freeze({
    version: KOTE_CONFIG_VERSION,
    default: defaultRoute,
    strict: input.strict,
    providers: Object.freeze(providers),
    auxiliaryOrigins: Object.freeze(
      Object.fromEntries([...auxiliaryOrigins].map(([providerID, origins]) => [providerID, Object.freeze(origins)])),
    ),
  })
}

export function defaultConfigPath(options: Omit<ConfigPathOptions, "configPath" | "logger"> = {}): string {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? homedir()
  if (platform === "win32") {
    return win32.join(env.APPDATA ?? win32.join(homeDirectory, "AppData", "Roaming"), "KoteGateway", "config.json")
  }
  if (platform === "linux" && env.XDG_CONFIG_HOME) {
    return posix.join(env.XDG_CONFIG_HOME, "kote-gateway", "config.json")
  }
  return posix.join(homeDirectory.replaceAll("\\", "/"), ".config", "kote-gateway", "config.json")
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env
  const environmentPath = env[KOTE_CONFIG_ENVIRONMENT_VARIABLE]?.trim()
  if (environmentPath && options.configPath) {
    options.logger?.debug?.("KOTE_GATEWAY_CONFIG overrides the plugin configPath option.", {
      configPath: environmentPath,
    })
  }
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? homedir()
  const selected = environmentPath || options.configPath || defaultConfigPath({ ...options, env, platform, homeDirectory })
  const expanded = expandHome(selected, homeDirectory, platform)
  if (platform === "win32") {
    return win32.normalize(win32.isAbsolute(expanded) ? expanded : win32.resolve(options.cwd ?? process.cwd(), expanded))
  }
  return posix.normalize(posix.isAbsolute(expanded) ? expanded : posix.resolve(options.cwd ?? process.cwd(), expanded))
}

export async function loadKoteGatewayConfig(options: ConfigPathOptions = {}): Promise<LoadedKoteGatewayConfig> {
  const configPath = resolveConfigPath(options)
  const file = Bun.file(configPath)
  if (!(await file.exists())) throw new KoteConfigNotFoundError({ configPath })

  const raw = await file.json().catch((cause: unknown) => {
    throw new KoteConfigInvalidError({
      configPath,
      message: `KoteGateway configuration at ${configPath} is not valid JSON.`,
      cause,
    })
  })
  return Object.freeze({ config: parseKoteGatewayConfig(raw, configPath, options.logger), configPath })
}

export function normalizeAuxiliaryOrigin(value: unknown, providerID?: string, configPath?: string): string {
  const field = `KoteGateway auxiliary origin${providerID ? ` for provider ${JSON.stringify(providerID)}` : ""}`
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${field} must be a URL.`, configPath)
  }
  const url = URL.parse(value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw invalid(`${field} must use HTTP or HTTPS.`, configPath)
  }
  if (url.username || url.password) {
    throw invalid(`${field} must not contain credentials.`, configPath)
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw invalid(`${field} must not contain a path, query, or fragment.`, configPath)
  }
  if (url.origin === KOTE_BOOTSTRAP_ORIGIN) {
    throw invalid("The KoteGateway bootstrap origin cannot be registered as a provider auxiliary origin.", configPath)
  }
  return url.origin
}

function requireRecord(value: unknown, field: string, configPath?: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`KoteGateway ${field} must be an object.`, configPath)
  }
  return value as Record<string, unknown>
}

function isRouteMode(value: unknown): value is RouteMode {
  return value === "direct" || value === "proxy"
}

function expandHome(value: string, homeDirectory: string, platform: string): string {
  if (value === "~") return homeDirectory
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value
  const remainder = value.slice(2)
  if (platform === "win32") return win32.join(homeDirectory, remainder)
  return posix.join(homeDirectory.replaceAll("\\", "/"), remainder.replaceAll("\\", "/"))
}

function invalid(message: string, configPath?: string) {
  return new KoteConfigInvalidError({ message, configPath })
}
