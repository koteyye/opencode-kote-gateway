import type { Hooks, Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import {
  createKoteGatewayClient,
  KoteConfigInvalidError,
  KoteGatewayError,
  type KoteGatewayLogger,
} from "./core/index.js"
import {
  applyProviderRouteHeaders,
  registerPluginInstance,
} from "./opencode/index.js"

const LOG_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LOG_RANK

export const server: Plugin = async (input, options) => {
  const logger = createLogger(input)
  const registered = await Promise.resolve()
    .then(() => registerPluginInstance({ bypassOrigins: [input.serverUrl.origin] }))
    .then(
      (registration) => ({ registration } as const),
      (error: unknown) => ({ error } as const),
    )
  if ("error" in registered) {
    const error = asPluginError(registered.error)
    logger.error(error.message, { code: error.code })
    return blockedHooks(error)
  }

  const configPath = readConfigPath(options)
  if (configPath instanceof KoteGatewayError) {
    registered.registration.block(configPath)
    logger.error(configPath.message, { code: configPath.code })
    return blockedHooks(configPath, registered.registration.dispose)
  }

  const loaded = await createKoteGatewayClient({
    ...(configPath === undefined ? {} : { configPath }),
    fetch: registered.registration.nextFetch,
    logger,
  }).then(
    (client) => ({ client } as const),
    (error: unknown) => ({ error: asPluginError(error) } as const),
  )
  if ("error" in loaded) {
    registered.registration.block(loaded.error)
    logger.error(loaded.error.message, {
      code: loaded.error.code,
      ...(loaded.error.configPath === undefined ? {} : { configPath: loaded.error.configPath }),
    })
    return blockedHooks(loaded.error, registered.registration.dispose)
  }

  registered.registration.activate(loaded.client)
  logger.info("KoteGateway plugin initialized.", { configPath: loaded.client.configPath })

  return {
    async dispose() {
      registered.registration.dispose()
    },
    "chat.headers": async (hookInput, output) => {
      const providerID = hookInput.model.providerID
      const mode = applyProviderRouteHeaders(
        registered.registration,
        loaded.client,
        { providerID, apiUrl: hookInput.model.api.url },
        output.headers,
      )
      logger.debug("KoteGateway selected a provider route.", {
        providerID,
        mode,
        ...originDetails(hookInput.model.api.url),
      })
    },
  }
}

const plugin = {
  id: "@koteyye/kote-gateway-opencode",
  server,
} satisfies PluginModule

export default plugin

function blockedHooks(error: KoteGatewayError, dispose: () => void = () => {}): Hooks {
  return {
    async dispose() {
      dispose()
    },
    "chat.headers": async () => {
      throw error
    },
  }
}

function readConfigPath(options: PluginOptions | undefined) {
  const value = options?.configPath
  if (value === undefined) return undefined
  if (typeof value === "string" && value.trim() !== "") return value
  return new KoteConfigInvalidError({
    message: 'KoteGateway plugin option "configPath" must be a non-empty string.',
  })
}

function asPluginError(error: unknown) {
  if (error instanceof KoteGatewayError) return error
  return new KoteConfigInvalidError({
    message: "KoteGateway plugin initialization failed; model requests are blocked.",
    cause: error,
  })
}

function createLogger(input: PluginInput): KoteGatewayLogger {
  const configured = process.env.KOTE_GATEWAY_LOG_LEVEL?.toLowerCase()
  const threshold = isLogLevel(configured) ? LOG_RANK[configured] : LOG_RANK.info
  const log = (level: LogLevel, message: string, details?: Readonly<Record<string, unknown>>) => {
    if (LOG_RANK[level] < threshold) return
    void input.client.app
      .log({
        body: {
          service: "kote-gateway",
          level,
          message,
          ...(details === undefined ? {} : { extra: { ...details } }),
        },
      })
      .catch(() => undefined)
  }
  return {
    debug: (message, details) => log("debug", message, details),
    info: (message, details) => log("info", message, details),
    warn: (message, details) => log("warn", message, details),
    error: (message, details) => log("error", message, details),
  }
}

function isLogLevel(level: string | undefined): level is LogLevel {
  return level !== undefined && Object.hasOwn(LOG_RANK, level)
}

function originDetails(value: string | undefined) {
  const origin = value ? URL.parse(value)?.origin : undefined
  return origin === undefined ? {} : { targetOrigin: origin }
}
