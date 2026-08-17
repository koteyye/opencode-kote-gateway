# Security model

KoteGateway is a routing layer, not an LLM provider and not a TLS interception service.

## CONNECT without MITM

For an HTTPS target, Bun sends the proxy a `CONNECT provider.example:443` request. After the proxy accepts it, OpenCode performs TLS with the original provider through the byte tunnel.

The proxy can observe client IP, destination hostname/port, connection timing, and byte counts. It cannot read the TLS-protected path, query, provider authorization, prompts, tool data, attachments, or responses unless TLS itself is compromised. The plugin installs no CA, substitutes no certificate, and does not rewrite the target URL to a gateway API.

## Target and proxy headers

Target headers include values such as `Authorization`, `ChatGPT-Account-Id`, `x-api-key`, and provider protocol headers. They remain on the target request inside TLS.

Proxy headers must be passed only through Bun's separate form:

```ts
{
  proxy: {
    url: descriptor.proxyUrl,
    headers: descriptor.proxyHeaders
  }
}
```

They must never be merged into the target `Headers`. The inherited signed bootstrap v1 wire format has no proxy-header or proxy-credential field, so the production descriptor normally omits `proxyHeaders`. Provider OAuth/API credentials are never converted into `Proxy-Authorization`.

## Signed bootstrap

The proxy origin is trusted only after verification of the v1 Ed25519 document. The client embeds the public key:

```text
d5e1f3f5353848e49e341ede50622b2d5c96bbf2817a02539c4b7e4ba0ef7bb3
```

The private key is not part of this repository, npm package, test fixtures, or CI. The signature covers canonical UTF-8 JSON excluding `signature`. HTTPS-only origin validation, exact version/time checks, a 10-second timeout, 64 KiB limit, and redirect rejection occur before the proxy URL can be used.

A verified remote document becomes last-known-good state. Invalid remote bytes never overwrite it. A correctly signed expired cache has a seven-day emergency grace window; beyond that window proxy routing fails. Cache files contain the public proxy origin and signed metadata, not provider tokens.

## Opaque route markers

For fetch-based model calls, the `chat.headers` hook inserts a cryptographically random, short-lived marker. The token does not encode provider ID, mode, instance ID, session ID, or a credential. Route context remains in a bounded in-memory registry. A visibly enabled native runtime on a `direct` route intentionally receives no marker because it bypasses the fetch interceptor; the same runtime is rejected for `proxy`.

The interceptor normally removes the marker before the target request. If a signing scheme explicitly includes it in its signed-header list, the marker is preserved to avoid invalidating the provider signature. In that edge case the provider receives only an opaque random value.

Expired, malformed, unknown-instance, and unresolvable markers fail according to the adapter's fail-closed routing policy; they do not select a guessed provider from URL or global mutable state. This behavior does not depend on the local configuration's unknown-field `strict` setting.

## OAuth boundary

OpenCode owns OAuth credentials and refresh. The plugin receives only the final request and does not inspect or persist bearer/refresh tokens. Its logs exclude authorization headers, cookies, bodies, and query strings.

Auxiliary-origin policy can route in-process token calls. The external browser is a separate process and is not controlled by this plugin. No browser credential or callback parameter is logged.

## Fail-closed guarantees

Within the verified fetch boundary, a `proxy` request either uses the validated descriptor or fails. Bootstrap failure, signature failure, expired cache, proxy connection error, unsafe request cloning, and blocked transport do not trigger a direct retry.

Configuration errors are retained in blocked instance state so a subsequent marked request cannot escape because a `config()` exception was swallowed.

## Explicit limitations

The following cannot be guaranteed solely by the public OpenCode 1.18.18 Plugin API:

- **Plugin absent or load failure.** OpenCode catches external-plugin install/init/config errors and continues. No code in a plugin that never initialized can enforce policy.
- **Arbitrary sockets.** `chat.headers` and global fetch interception do not control a provider that uses `net`, TLS, QUIC, a native library, or an unrelated WebSocket client directly.
- **Pre-captured custom fetch.** A third-party wrapper that captured the original fetch before KoteGateway loaded may bypass the interceptor.
- **Marker removal combined with an origin rewrite.** If one transport removes the opaque marker and rewrites the request to an origin explicitly registered as another provider's auxiliary origin, the final unmarked fetch is indistinguishable from legitimate auxiliary traffic and can follow that auxiliary route. The adapter blocks observed same-origin route conflicts, but the public API exposes no correlation signal after both the header and original origin are gone.
- **Programmatic native-runtime flags.** The documented environment opt-in can be blocked for proxy routing, but runtime overrides are not exposed to public hooks.
- **OpenAI HTTP-forcing stability.** The 1.18.18 WebSocket guard relies on OpenCode's internal `x-opencode-title` HTTP-fallback behavior. This is source-audited and exercised synthetically, but it is not observable or guaranteed by the public API.

Use host firewall, container network policy, or an allowlisted egress proxy when the security objective requires process-wide proof even if the plugin is missing or a new transport bypasses fetch.

## Logging and incident handling

Allowed diagnostic fields are configuration path, provider ID, route, sanitized target origin, bootstrap cache hit/miss, and gateway origin. Disallowed fields include complete target URLs, paths/queries, bodies, credentials, cookies, proxy authorization, and whole bootstrap documents.

On a suspected routing failure, preserve sanitized error codes and counters rather than raw requests. Rotate provider credentials if there is evidence they escaped TLS; rotating the bootstrap signing key requires publishing a new plugin version because the current client trusts one embedded public key.
