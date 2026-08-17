import type { RouteMode } from "../core/index.js"
import { DEFAULT_MARKER_MAX_SIZE, DEFAULT_MARKER_TTL_MS } from "./constants.js"

export type RouteContext = {
  readonly providerID: string
  readonly mode: RouteMode
  readonly instanceID: string
  readonly expiresAt: number
}

export type MarkerRegistryOptions = {
  readonly ttlMs?: number
  readonly maxSize?: number
  readonly now?: () => number
  readonly random?: (bytes: Uint8Array) => Uint8Array
}

export class MarkerRegistry {
  readonly #entries = new Map<string, RouteContext>()
  readonly #ttlMs: number
  readonly #maxSize: number
  readonly #now: () => number
  readonly #random: (bytes: Uint8Array) => Uint8Array

  constructor(options: MarkerRegistryOptions = {}) {
    this.#ttlMs = positiveInteger(options.ttlMs, DEFAULT_MARKER_TTL_MS, "marker TTL")
    this.#maxSize = positiveInteger(options.maxSize, DEFAULT_MARKER_MAX_SIZE, "marker maximum size")
    this.#now = options.now ?? Date.now
    this.#random = options.random ?? ((bytes) => crypto.getRandomValues(bytes))
  }

  get size() {
    this.cleanup()
    return this.#entries.size
  }

  issue(input: Omit<RouteContext, "expiresAt">) {
    this.cleanup()
    if (this.#entries.size >= this.#maxSize) {
      const oldest = this.#entries.keys().next().value
      if (oldest !== undefined) this.#entries.delete(oldest)
    }

    const token = this.#createUniqueToken()
    this.#entries.set(token, {
      ...input,
      expiresAt: this.#now() + this.#ttlMs,
    })
    return token
  }

  lookup(token: string) {
    if (!isMarkerToken(token)) return undefined
    const context = this.#entries.get(token)
    if (!context) return undefined
    if (context.expiresAt > this.#now()) return context
    this.#entries.delete(token)
    return undefined
  }

  cleanup() {
    const now = this.#now()
    this.#entries.forEach((context, token) => {
      if (context.expiresAt <= now) this.#entries.delete(token)
    })
  }

  clearInstance(instanceID: string) {
    this.#entries.forEach((context, token) => {
      if (context.instanceID === instanceID) this.#entries.delete(token)
    })
  }

  clear() {
    this.#entries.clear()
  }

  #createUniqueToken(attempt = 0): string {
    if (attempt >= 8) throw new TypeError("marker random source repeatedly returned duplicate tokens")
    const bytes = this.#random(new Uint8Array(32))
    if (bytes.byteLength !== 32) throw new TypeError("marker random source must return 32 bytes")
    const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    if (!this.#entries.has(token)) return token
    return this.#createUniqueToken(attempt + 1)
  }
}

export function isMarkerToken(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}
