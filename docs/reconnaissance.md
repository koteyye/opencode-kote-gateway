# Reconnaissance

This document records the source inspection that preceded the standalone plugin. It separates facts verified in source from guarantees that the public OpenCode plugin API cannot provide.

## Audited revisions

| Component | Revision |
| --- | --- |
| KoteCode | `47f2de0b713478cddeed3f2af1e559579d3ea32d` |
| OpenCode | 1.18.18, `2cba7e227d68a7e7e4a2aa9c85b808e8ecb14daf` |
| `@opencode-ai/plugin` | 1.18.18 |
| Bun | 1.3.14 |

The OpenCode commit was inspected directly from the upstream Git object, not inferred from prose documentation.

## KoteCode source inventory

The portable pieces were located under `packages/core/src/kote/`:

- `bootstrap.ts`: strict v1 parsing, canonical JSON, Ed25519 verification, remote fetch, last-known-good cache, grace handling, and resolution precedence;
- `keys.ts`: embedded verification key and safety limits;
- `proxy.ts`: per-request Bun proxy option, HTTPS enforcement, and fail-closed errors;
- `provider-routing.ts`: `direct`/`proxy` route selection;
- `gateway.ts`: KoteCode UI/config selection of a custom proxy.

Tests were in `packages/core/test/kote-bootstrap.test.ts`, `kote-security.test.ts`, and `kote-gateway.test.ts`. Protocol and network documentation was in `docs/BOOTSTRAP.md` and `docs/NETWORK.md`.

The old integration was not portable as-is. It changed internal OpenCode files including `packages/opencode/src/provider/provider.ts`, the built-in OpenAI OAuth plugin, plugin initialization, and the native LLM runtime. Those changes could directly wrap provider options and pass proxy state into internal execution paths. A standalone package may not import or modify those internals.

## Exact bootstrap protocol

The source-of-truth wire document is:

```json
{
  "config_version": 1,
  "proxy": {
    "url": "https://kote-proxy.kotey-ye.ru"
  },
  "issued_at": "2026-07-28T00:00:00.000Z",
  "expires_at": "2026-08-27T00:00:00.000Z",
  "signature": "<128 lowercase or uppercase hexadecimal characters>"
}
```

Verified behavior:

- default URL: `https://kote-bootstrap.kotey-ye.ru/bootstrap.json`;
- request: HTTPS `GET`, `Accept: application/json`, no credentials or body;
- redirect mode: `error`;
- timeout: 10,000 ms for the complete fetch/read operation;
- maximum body: 64 KiB, enforced from `Content-Length` and while streaming;
- version: exactly `1`;
- `proxy.url`: an HTTPS origin with no username, password, path other than `/`, query, or fragment;
- dates: canonical JavaScript ISO strings; `expires_at` must be later than `issued_at`;
- not-yet-valid documents and expired remote documents are rejected;
- algorithm: Ed25519 via `@noble/ed25519`;
- public key: `d5e1f3f5353848e49e341ede50622b2d5c96bbf2817a02539c4b7e4ba0ef7bb3`;
- signature: detached 64-byte signature encoded as 128 hex characters;
- signed bytes: UTF-8 encoding of the canonical unsigned JSON document;
- canonicalization: object keys recursively sorted by JavaScript string comparison, no whitespace, arrays retain order, `undefined` object values are omitted;
- an invalid remote document never replaces the last-known-good cache;
- an expired, still correctly signed cache is usable until strictly less than seven days after `expires_at`;
- after the grace window, resolution fails closed;
- the legacy client made one remote attempt per resolution and then considered the verified cache. It did not implement a retry loop and did not fall back to direct transport.

The v1 document contains only `proxy.url`. It has no proxy username, password, `Proxy-Authorization`, arbitrary proxy headers, model list, or executable instructions. The standalone implementation therefore must not invent any such wire fields.

Like the KoteCode parser, verification projects the input onto the known fields and signs/verifies that projection. Extra JSON fields are ignored and cannot influence the descriptor; a document missing or invalidating any required known field is rejected. This detail is preserved for wire compatibility rather than replaced with stricter whole-object rejection.

The KoteCode cache was `<KoteCode cache>/kote/bootstrap.json`. The standalone package uses its own application cache namespace so it does not depend on KoteCode being installed: XDG/`~/.cache/kote-gateway/bootstrap.json` on Linux, `~/Library/Caches/KoteGateway/bootstrap.json` on macOS, and `%LOCALAPPDATA%\\KoteGateway\\bootstrap.json` on Windows (with `%APPDATA%` fallback). The wire bytes and verification rules remain compatible.

## KoteCode data flow

```text
model selection
  -> providerID
  -> read direct/proxy route
  -> resolve signed bootstrap or verified LKG cache
  -> keep original provider URL and provider headers
  -> pass proxy origin as Bun fetch proxy option
  -> HTTPS CONNECT tunnel
  -> fail on proxy/bootstrap error (never retry direct)
```

KoteCode performed routing inside provider construction. It could preserve a provider-specific `fetch` by wrapping that function and could explicitly pass the same proxy transport into OpenAI OAuth and native runtime internals. The standalone adapter instead depends on the final network operation reaching a captured global fetch.

## OpenCode public seam

OpenCode 1.18.18 publishes:

```ts
export type PluginOptions = Record<string, unknown>

export type Plugin = (
  input: PluginInput,
  options?: PluginOptions,
) => Promise<Hooks>
```

Its configuration type permits both a string and `[string, PluginOptions]`. `Hooks["chat.headers"]` receives a model whose `providerID` is the exact selected ID and mutates `output.headers: Record<string, string>`.

In `packages/opencode/src/session/llm/request.ts`, OpenCode invokes `chat.headers`, then merges the result after model headers into the headers passed to the provider execution. This is the public point used to attach an opaque route token. Provider creation loads plugins and runs their config hooks before reading provider config, so the standalone initializer can install the process fetch wrapper before ordinary provider SDK creation.

The final routing sequence is:

```text
chat.headers(providerID)
  -> issue opaque random marker
  -> provider/OAuth/signing logic receives marker
  -> final fetch wrapper resolves marker
  -> direct: captured nextFetch
  -> proxy: verified descriptor + captured nextFetch({ proxy })
```

The marker is an in-memory correlation token, not an identity header. It does not encode provider ID, session ID, mode, or credentials.

## Authentication observations

OpenCode's built-in OpenAI OAuth transport in 1.18.18:

1. obtains current auth from OpenCode;
2. refreshes expired access through `https://auth.openai.com/oauth/token`;
3. removes an SDK-supplied authorization header;
4. adds the current bearer `Authorization`;
5. adds `ChatGPT-Account-Id` when available;
6. rewrites Responses/chat-completions model calls to `https://chatgpt.com/backend-api/codex/responses`;
7. calls its HTTP fetch after these transformations.

Consequently the adapter neither needs nor is permitted to read tokens. Auxiliary-origin routing covers in-process OAuth requests that have no model marker. The external browser navigation is not an in-process fetch.

Other audited custom-fetch examples include Google Vertex adding an access token before calling global fetch and Snowflake transforming request/response bodies around global fetch. The fetch interceptor sits after those wrappers when they call the patched global function. This is evidence for those code paths, not a universal claim about every possible third-party transport.

## Transport gaps and compatibility contracts

### WebSocket

OpenCode's OpenAI WebSocket pool creates a `ws` socket directly for streaming `/responses`. That socket does not pass through global fetch. In 1.18.18, the pool falls back to its captured HTTP fetch when the internal `x-opencode-title` request header equals `true`, and strips that header before the HTTP request. The adapter uses that behavior for proxied OpenAI requests.

`x-opencode-title` is not documented as a public plugin contract and the public hook cannot confirm that OpenCode honored it. It is a compatibility dependency audited at 1.18.18; the supported range must not be expanded without source review and retesting. The public API offers no general mechanism for intercepting arbitrary custom WebSockets.

### Native LLM runtime

`OPENCODE_EXPERIMENTAL_NATIVE_LLM` selects a separate `@opencode-ai/llm` path. OpenCode's internal code can inject `FetchHttpClient.Fetch`, but that seam is not public to external plugins. The adapter can observe and reject the documented environment opt-in for proxy routing. The public hooks do not reveal a programmatically overridden runtime flag or conclusively identify the runtime ultimately selected, so no stronger guarantee is claimed.

### Plugin load failure

OpenCode 1.18.18 catches external plugin resolution, initialization, `config()` hook, and disposal errors, logs/publishes an error, and continues. Once this plugin initializes, blocked configuration and proxy errors fail marked requests. If the plugin never installs or initializes, an external plugin has no public enforcement point. Process-wide fail-closed policy requires OS, container, or network egress controls.

### Arbitrary custom clients

A provider-specific fetch that calls the patched global fetch is routed. A function that captured an older fetch before plugin initialization, uses an imported HTTP client, or opens sockets directly may bypass it. The public API cannot prove otherwise. Compatibility is therefore described by transport class and evidence, not by a provider allowlist.
