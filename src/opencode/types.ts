import type { KoteGatewayClient } from "../core/index.js"

export type AdapterClient = Pick<
  KoteGatewayClient,
  "resolveRoute" | "resolveProviderByOrigin" | "getGateway" | "invalidateGateway"
>

export type ReadyInstance = {
  readonly status: "ready"
  readonly instanceID: string
  readonly client: AdapterClient
  readonly observedOrigins: ReadonlyMap<string, ReadonlySet<string>>
  readonly bypassOrigins?: ReadonlySet<string>
}

export type LoadingInstance = {
  readonly status: "loading"
  readonly instanceID: string
  readonly observedOrigins: ReadonlyMap<string, ReadonlySet<string>>
  readonly bypassOrigins?: ReadonlySet<string>
}

export type BlockedInstance = {
  readonly status: "blocked"
  readonly instanceID: string
  readonly error: unknown
  readonly observedOrigins: ReadonlyMap<string, ReadonlySet<string>>
  readonly bypassOrigins?: ReadonlySet<string>
}

export type PluginInstanceState = ReadyInstance | LoadingInstance | BlockedInstance

export type AuxiliaryRoute = {
  readonly instance: ReadyInstance
  readonly providerID: string
  readonly mode: "direct" | "proxy"
}
