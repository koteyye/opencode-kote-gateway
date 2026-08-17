import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import {
  KoteBootstrapExpiredError,
  KoteBootstrapInvalidError,
  KoteBootstrapSignatureInvalidError,
  KoteBootstrapUnavailableError,
  type KoteGatewayError,
} from "./errors.js"
import type { KoteGatewayLoggerInput } from "./logging.js"

export const KOTE_BOOTSTRAP_URL = "https://kote-bootstrap.kotey-ye.ru/bootstrap.json" as const
export const KOTE_BOOTSTRAP_ORIGIN = "https://kote-bootstrap.kotey-ye.ru" as const
export const KOTE_BOOTSTRAP_PUBLIC_KEY_HEX = "d5e1f3f5353848e49e341ede50622b2d5c96bbf2817a02539c4b7e4ba0ef7bb3" as const
export const KOTE_BOOTSTRAP_CONFIG_VERSION = 1 as const
export const KOTE_BOOTSTRAP_TIMEOUT_MS = 10_000
export const KOTE_BOOTSTRAP_MAX_BYTES = 64 * 1024
export const KOTE_BOOTSTRAP_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

export interface BootstrapConfig {
  config_version: number
  proxy: Readonly<{ url: string }>
  issued_at: string
  expires_at: string
  signature: string
}

export type BootstrapVerifyError =
  | Readonly<{ _tag: "BadSignature" }>
  | Readonly<{ _tag: "UnknownConfigVersion"; got: number }>
  | Readonly<{ _tag: "NotYetValid"; issuedAt: string; now: Date }>
  | Readonly<{ _tag: "Expired"; expiresAt: string; now: Date }>
  | Readonly<{ _tag: "Malformed"; message: string }>

export interface VerifyBootstrapOptions {
  now?: Date | undefined
  publicKeyHex?: string | undefined
  allowExpired?: boolean | undefined
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type GatewayDescriptor = Readonly<{
  proxyUrl: string
  proxyHeaders?: Readonly<Record<string, string>>
  expiresAt?: number
}>

export type ResolvedGatewayBootstrap = Readonly<{
  descriptor: GatewayDescriptor
  config: BootstrapConfig
  source: "remote" | "cache"
  usableUntil: number
}>

export interface FetchRemoteBootstrapOptions {
  fetch: FetchLike
  url?: string | undefined
  timeoutMs?: number | undefined
  maxBytes?: number | undefined
}

export interface ResolveGatewayBootstrapOptions {
  fetch: FetchLike
  cachePath: string
  bootstrapUrl?: string | undefined
  publicKeyHex?: string | undefined
  now?: Date | undefined
  logger?: KoteGatewayLoggerInput | undefined
}

export function parseBootstrapConfig(raw: unknown): BootstrapConfig {
  const input = requireObject(raw, "config")
  const proxy = requireObject(input.proxy, "proxy")
  const issuedAt = requireIsoDate(input.issued_at, "issued_at")
  const expiresAt = requireIsoDate(input.expires_at, "expires_at")
  if (new Date(expiresAt) <= new Date(issuedAt)) {
    throw new KoteBootstrapInvalidError({ message: "bootstrap: expires_at must be after issued_at" })
  }
  return Object.freeze({
    config_version: requireVersion(input.config_version),
    proxy: Object.freeze({ url: requireProxyUrl(proxy.url, "proxy.url") }),
    issued_at: issuedAt,
    expires_at: expiresAt,
    signature: requireSignature(input.signature),
  })
}

export function signingMessage(input: BootstrapConfig): string {
  return canonicalJson({
    config_version: input.config_version,
    proxy: { url: input.proxy.url },
    issued_at: input.issued_at,
    expires_at: input.expires_at,
  } satisfies Omit<BootstrapConfig, "signature">)
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)!
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`
}

export async function verifyBootstrapConfig(
  raw: unknown,
  options: VerifyBootstrapOptions = {},
): Promise<Readonly<{ ok: true; config: BootstrapConfig }> | Readonly<{ ok: false; error: BootstrapVerifyError }>> {
  const parsed = parseBootstrapResult(raw)
  if (!parsed.ok) return parsed
  if (parsed.config.config_version !== KOTE_BOOTSTRAP_CONFIG_VERSION) {
    return { ok: false, error: { _tag: "UnknownConfigVersion", got: parsed.config.config_version } }
  }

  const now = options.now ?? new Date()
  if (new Date(parsed.config.issued_at) > now) {
    return { ok: false, error: { _tag: "NotYetValid", issuedAt: parsed.config.issued_at, now } }
  }
  if (!options.allowExpired && new Date(parsed.config.expires_at) <= now) {
    return { ok: false, error: { _tag: "Expired", expiresAt: parsed.config.expires_at, now } }
  }

  const message = new TextEncoder().encode(signingMessage(parsed.config))
  const publicKey = Buffer.from(options.publicKeyHex ?? KOTE_BOOTSTRAP_PUBLIC_KEY_HEX, "hex")
  const valid = await verifySignature(parsed.config.signature, message, publicKey)
  if (!valid) return { ok: false, error: { _tag: "BadSignature" } }
  return { ok: true, config: parsed.config }
}

export async function signBootstrapConfig(
  unsigned: Omit<BootstrapConfig, "signature">,
  privateKeyHex: string,
): Promise<BootstrapConfig> {
  const { signAsync } = await import("@noble/ed25519")
  const normalized = parseBootstrapConfig({ ...unsigned, signature: "unsigned" })
  const signature = await signAsync(
    new TextEncoder().encode(signingMessage(normalized)),
    Buffer.from(privateKeyHex, "hex"),
  )
  return Object.freeze({ ...normalized, signature: Buffer.from(signature).toString("hex") })
}

export async function fetchRemoteBootstrap(options: FetchRemoteBootstrapOptions): Promise<unknown> {
  const target = URL.parse(options.url ?? KOTE_BOOTSTRAP_URL)
  if (!target || target.protocol !== "https:") {
    throw new KoteBootstrapInvalidError({ message: "bootstrap URL must use HTTPS" })
  }
  if (target.username || target.password) {
    throw new KoteBootstrapInvalidError({ message: "bootstrap URL must not contain credentials" })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? KOTE_BOOTSTRAP_TIMEOUT_MS)
  try {
    const response = await options.fetch(target, {
      signal: controller.signal,
      redirect: "error",
      headers: { accept: "application/json" },
    })
    if (!response.ok) {
      throw new KoteBootstrapUnavailableError({ message: `KoteGateway bootstrap returned HTTP ${response.status}.` })
    }
    const maxBytes = options.maxBytes ?? KOTE_BOOTSTRAP_MAX_BYTES
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      throw new KoteBootstrapInvalidError({ message: "bootstrap response too large (content-length)" })
    }
    const reader = response.body?.getReader()
    if (!reader) throw new KoteBootstrapInvalidError({ message: "bootstrap: no response body" })

    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) throw new KoteBootstrapInvalidError({ message: "bootstrap response too large (streamed)" })
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(total)
    chunks.reduce((offset, chunk) => {
      bytes.set(chunk, offset)
      return offset + chunk.byteLength
    }, 0)
    return parseRemoteJson(new TextDecoder().decode(bytes))
  } finally {
    clearTimeout(timer)
  }
}

export async function readBootstrapCache(
  cachePath: string,
  options: Pick<VerifyBootstrapOptions, "now" | "publicKeyHex"> = {},
): Promise<BootstrapConfig | undefined> {
  const file = Bun.file(cachePath)
  if (!(await file.exists())) return undefined
  const raw = await file.json().catch(() => undefined)
  if (raw === undefined) return undefined
  const result = await verifyBootstrapConfig(raw, { ...options, allowExpired: true })
  if (!result.ok) return undefined
  return result.config
}

export async function writeBootstrapCache(config: BootstrapConfig, cachePath: string): Promise<void> {
  const temporary = `${cachePath}.tmp-${process.pid}-${randomUUID()}`
  await mkdir(dirname(cachePath), { recursive: true })
    .then(() => Bun.write(temporary, JSON.stringify(config, null, 2)))
    .then(() => rename(temporary, cachePath))
    .catch(() => rm(temporary, { force: true }).catch(() => undefined))
}

export function isBootstrapCacheUsable(config: BootstrapConfig, now: Date = new Date()): boolean {
  const expiresAt = new Date(config.expires_at).getTime()
  if (expiresAt > now.getTime()) return true
  return now.getTime() < expiresAt + KOTE_BOOTSTRAP_GRACE_PERIOD_MS
}

export async function resolveGatewayBootstrap(
  options: ResolveGatewayBootstrapOptions,
): Promise<ResolvedGatewayBootstrap> {
  const remote = await fetchRemoteBootstrap({ fetch: options.fetch, url: options.bootstrapUrl })
    .then((raw) => verifyBootstrapConfig(raw, { now: options.now, publicKeyHex: options.publicKeyHex }))
    .then(async (result) => {
      if (!result.ok) return { error: verificationError(result.error) } as const
      await writeBootstrapCache(result.config, options.cachePath)
      return { config: result.config } as const
    })
    .catch((cause: unknown) => ({
      error:
        cause instanceof KoteBootstrapInvalidError || cause instanceof KoteBootstrapUnavailableError
          ? cause
          : new KoteBootstrapUnavailableError({ cause }),
    }) as const)

  if ("config" in remote) {
    options.logger?.debug?.("KoteGateway bootstrap cache miss; using verified remote bootstrap.", {
      gatewayOrigin: remote.config.proxy.url,
    })
    return resolved(remote.config, "remote", new Date(remote.config.expires_at).getTime())
  }

  const cached = await readBootstrapCache(options.cachePath, {
    now: options.now,
    publicKeyHex: options.publicKeyHex,
  })
  if (cached && isBootstrapCacheUsable(cached, options.now)) {
    options.logger?.debug?.("KoteGateway bootstrap cache hit.", { gatewayOrigin: cached.proxy.url })
    const expiresAt = new Date(cached.expires_at).getTime()
    return resolved(
      cached,
      "cache",
      expiresAt > (options.now ?? new Date()).getTime() ? expiresAt : expiresAt + KOTE_BOOTSTRAP_GRACE_PERIOD_MS,
    )
  }

  options.logger?.debug?.("KoteGateway bootstrap cache miss; no usable verified entry exists.")
  throw remote.error
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} missing` })
  }
  return value as Record<string, unknown>
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string") throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} not an ISO date` })
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} not an ISO date` })
  }
  return value
}

function requireProxyUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} missing` })
  }
  const url = URL.parse(value)
  if (!url) throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} must be a valid URL` })
  if (url.protocol !== "https:") throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} must use HTTPS` })
  if (url.username || url.password) {
    throw new KoteBootstrapInvalidError({ message: `bootstrap: ${field} must not contain credentials` })
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new KoteBootstrapInvalidError({
      message: `bootstrap: ${field} must be an HTTPS origin without path, query, or fragment`,
    })
  }
  return url.origin
}

function requireVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KoteBootstrapInvalidError({ message: "bootstrap: config_version missing" })
  }
  return value
}

function requireSignature(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KoteBootstrapInvalidError({ message: "bootstrap: signature missing" })
  }
  return value
}

function parseBootstrapResult(
  raw: unknown,
): Readonly<{ ok: true; config: BootstrapConfig }> | Readonly<{ ok: false; error: BootstrapVerifyError }> {
  try {
    return { ok: true, config: parseBootstrapConfig(raw) }
  } catch (cause) {
    return {
      ok: false,
      error: {
        _tag: "Malformed",
        message: cause instanceof Error ? cause.message : "bootstrap: malformed configuration",
      },
    }
  }
}

function parseRemoteJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new KoteBootstrapInvalidError({ message: "KoteGateway bootstrap is not valid JSON.", cause })
  }
}

async function verifySignature(signatureHex: string, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || publicKey.length !== 32) return false
  const { verifyAsync } = await import("@noble/ed25519")
  return verifyAsync(Buffer.from(signatureHex, "hex"), message, publicKey).catch(() => false)
}

function verificationError(error: BootstrapVerifyError): KoteGatewayError {
  if (error._tag === "BadSignature") return new KoteBootstrapSignatureInvalidError()
  if (error._tag === "Expired") return new KoteBootstrapExpiredError()
  if (error._tag === "NotYetValid") {
    return new KoteBootstrapInvalidError({ message: "KoteGateway bootstrap is not yet valid; clock skew is not accepted." })
  }
  if (error._tag === "UnknownConfigVersion") {
    return new KoteBootstrapInvalidError({ message: `Unsupported KoteGateway bootstrap version ${error.got}.` })
  }
  return new KoteBootstrapInvalidError({ message: error.message })
}

function resolved(
  config: BootstrapConfig,
  source: ResolvedGatewayBootstrap["source"],
  usableUntil: number,
): ResolvedGatewayBootstrap {
  return Object.freeze({
    descriptor: Object.freeze({
      proxyUrl: config.proxy.url,
      expiresAt: new Date(config.expires_at).getTime(),
    }),
    config,
    source,
    usableUntil,
  })
}
