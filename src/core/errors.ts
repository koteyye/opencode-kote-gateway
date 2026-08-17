export const KOTE_ERROR_CODES = [
  "KOTE_CONFIG_NOT_FOUND",
  "KOTE_CONFIG_INVALID",
  "KOTE_ROUTE_TOKEN_INVALID",
  "KOTE_PROVIDER_CONTEXT_MISSING",
  "KOTE_BOOTSTRAP_UNAVAILABLE",
  "KOTE_BOOTSTRAP_INVALID",
  "KOTE_BOOTSTRAP_SIGNATURE_INVALID",
  "KOTE_BOOTSTRAP_EXPIRED",
  "KOTE_GATEWAY_UNAVAILABLE",
  "KOTE_PROXY_REQUEST_FAILED",
  "KOTE_UNSUPPORTED_TRANSPORT",
  "KOTE_REQUEST_CLONE_FAILED",
  "KOTE_GLOBAL_STATE_CONFLICT",
] as const

export type KoteErrorCode = (typeof KOTE_ERROR_CODES)[number]
export type RouteMode = "direct" | "proxy"

export type KoteErrorDetails = Readonly<{
  code: KoteErrorCode
  message: string
  providerID?: string | undefined
  mode?: RouteMode | undefined
  targetOrigin?: string | undefined
  configPath?: string | undefined
  cause?: unknown
}>

export type KoteErrorContext = Omit<KoteErrorDetails, "code" | "message"> & {
  message?: string
}

export class KoteGatewayError extends Error {
  readonly code: KoteErrorCode
  readonly providerID: string | undefined
  readonly mode: RouteMode | undefined
  readonly targetOrigin: string | undefined
  readonly configPath: string | undefined

  constructor(details: KoteErrorDetails) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = new.target.name
    this.code = details.code
    this.providerID = details.providerID
    this.mode = details.mode
    this.targetOrigin = details.targetOrigin
    this.configPath = details.configPath
  }
}

export class KoteConfigNotFoundError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_CONFIG_NOT_FOUND",
      message: details.message ?? `KoteGateway configuration was not found${details.configPath ? ` at ${details.configPath}` : ""}.`,
    })
  }
}

export class KoteConfigInvalidError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_CONFIG_INVALID",
      message: details.message ?? `KoteGateway configuration is invalid${details.configPath ? ` at ${details.configPath}` : ""}.`,
    })
  }
}

export class KoteRouteTokenInvalidError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({ ...details, code: "KOTE_ROUTE_TOKEN_INVALID", message: details.message ?? "KoteGateway route token is invalid." })
  }
}

export class KoteProviderContextMissingError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_PROVIDER_CONTEXT_MISSING",
      message: details.message ?? "KoteGateway could not associate the request with a provider.",
    })
  }
}

export class KoteBootstrapUnavailableError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_BOOTSTRAP_UNAVAILABLE",
      message: details.message ?? "KoteGateway bootstrap is unavailable and no usable verified cache exists.",
    })
  }
}

export class KoteBootstrapInvalidError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({ ...details, code: "KOTE_BOOTSTRAP_INVALID", message: details.message ?? "KoteGateway bootstrap is invalid." })
  }
}

export class KoteBootstrapSignatureInvalidError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_BOOTSTRAP_SIGNATURE_INVALID",
      message: details.message ?? "KoteGateway bootstrap signature is invalid.",
    })
  }
}

export class KoteBootstrapExpiredError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({ ...details, code: "KOTE_BOOTSTRAP_EXPIRED", message: details.message ?? "KoteGateway bootstrap has expired." })
  }
}

export class KoteGatewayUnavailableError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_GATEWAY_UNAVAILABLE",
      message:
        details.message ??
        `KoteGateway is unavailable${details.providerID ? ` for provider ${details.providerID}` : ""}; direct fallback was not attempted.`,
    })
  }
}

export class KoteProxyRequestFailedError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_PROXY_REQUEST_FAILED",
      message:
        details.message ??
        `KoteGateway proxy request failed${details.providerID ? ` for provider ${details.providerID}` : ""}; direct fallback was not attempted.`,
    })
  }
}

export class KoteUnsupportedTransportError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_UNSUPPORTED_TRANSPORT",
      message: details.message ?? "The selected transport cannot be routed safely through KoteGateway.",
    })
  }
}

export class KoteRequestCloneFailedError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_REQUEST_CLONE_FAILED",
      message: details.message ?? "The request could not be cloned safely for KoteGateway routing.",
    })
  }
}

export class KoteGlobalStateConflictError extends KoteGatewayError {
  constructor(details: KoteErrorContext = {}) {
    super({
      ...details,
      code: "KOTE_GLOBAL_STATE_CONFLICT",
      message: details.message ?? "An incompatible KoteGateway global state is already installed.",
    })
  }
}
