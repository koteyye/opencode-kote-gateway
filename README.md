# KoteGateway for OpenCode

`@koteyye/kote-gateway-opencode` routes OpenCode provider traffic either directly or through the KoteGateway HTTPS `CONNECT` proxy. It is a standalone OpenCode plugin: it does not patch OpenCode, replace providers, copy credentials, or add UI.

The route is selected by the exact `model.providerID` supplied to the public `chat.headers` hook. There is no provider allowlist. A new provider automatically uses the configured default when its HTTP transport reaches the process `fetch` interceptor.

> Compatibility ceiling: OpenCode 1.18.18. The source audit used OpenCode 1.18.18 (`2cba7e227d68a7e7e4a2aa9c85b808e8ecb14daf`), `@opencode-ai/plugin` 1.18.18, and Bun 1.3.14. See [Provider compatibility](docs/provider-compatibility.md) before enabling proxy mode for a new transport.

## Routing model

- `direct`: the provider's existing transport calls the fetch implementation that was present when the plugin loaded. KoteGateway is not consulted.
- `proxy`: the original provider URL is fetched with Bun's per-request `proxy` option. Bootstrap or proxy failure terminates the request. There is no automatic direct fallback.

For HTTPS targets, Bun opens a `CONNECT host:port` tunnel and TLS remains end to end between OpenCode and the provider. Provider authorization stays in the encrypted target request; it is not repurposed as proxy authorization.

## Install

Add the package to the OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@koteyye/kote-gateway-opencode"
  ]
}
```

OpenCode installs npm plugins with Bun. The audited 1.18.18 public plugin type also accepts a tuple with plugin options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@koteyye/kote-gateway-opencode",
      {
        "configPath": "~/.config/kote-gateway/config.json"
      }
    ]
  ]
}
```

## Configure

Create `config.json`:

```json
{
  "version": 1,
  "default": "proxy",
  "strict": true,
  "providers": {
    "openai": "proxy",
    "anthropic": "proxy",
    "openrouter": "direct",
    "google": "proxy",
    "amazon-bedrock": "proxy",
    "github-copilot": "direct",
    "ollama": "direct"
  }
}
```

The audited OpenAI origins `https://auth.openai.com`, `https://api.openai.com`, and `https://chatgpt.com` are merged automatically. `auxiliaryOrigins` is only needed for additional or custom-provider origins.

Configuration lookup order is:

1. `KOTE_GATEWAY_CONFIG` (absolute or relative path);
2. tuple option `configPath`;
3. the platform default.

| Platform | Default path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/kote-gateway/config.json`, otherwise `~/.config/kote-gateway/config.json` |
| macOS | `~/.config/kote-gateway/config.json` |
| Windows | `%APPDATA%\\KoteGateway\\config.json` |

Only `direct` and `proxy` are valid route values. Provider IDs are arbitrary non-empty strings. Auxiliary entries must be bare HTTP(S) origins without credentials, path, query, or fragment. Conflicting ownership of an origin is rejected. Restart OpenCode after editing the file; v1 does not hot reload configuration.

See [Configuration](docs/configuration.md) for the complete schema and validation behavior.

## OAuth and provider-specific authentication

Continue to use OpenCode's normal `/connect` flow. The plugin does not read, store, refresh, or log OAuth tokens.

For OpenAI ChatGPT Plus/Pro OAuth, OpenCode remains responsible for refreshing the access token, setting `Authorization` and `ChatGPT-Account-Id`, and rewriting the model URL to the Codex endpoint. The final HTTP fetch is then routed. In-process requests to configured auxiliary origins, including token exchange and refresh, use the same route as `openai`.

The authorization page itself opens in an external browser. Browser traffic is outside the OpenCode process and therefore outside this plugin. A successful browser login does not prove that the browser connection traversed KoteGateway.

No real OpenAI OAuth credentials or completed real-OAuth E2E result are included in this repository. The automated suite uses synthetic request chains only; the release checklist is in [Testing](docs/testing.md).

## WebSocket and native transports

The public plugin API exposes HTTP headers, not arbitrary sockets.

- OpenAI WebSocket mode in OpenCode 1.18.18 can bypass `globalThis.fetch`. For a proxied OpenAI route, the adapter requests that version's built-in HTTP fallback using the internal `x-opencode-title` behavior. This is not observable through the public API, so the package is pinned through the audited 1.18.18 release and the range must not be expanded without source review and a compatibility retest.
- `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` is rejected for proxy routing because the public hook does not expose enough runtime state to prove that its HTTP client is intercepted. Direct routes remain OpenCode-owned. A programmatically supplied runtime-flag override is not observable through the public Plugin API, so the plugin cannot claim process-wide enforcement in that case.
- Any third-party WebSocket, native socket, or custom client that never calls the captured process fetch is outside the verifiable routing boundary. Do not use proxy mode for it without a transport contract test or system-level egress policy.
- A wrapper that both removes the opaque marker and rewrites to an origin configured as another provider's auxiliary traffic is ambiguous to the public API. Do not rely on plugin-only fail-closed enforcement for that combination.

See [Provider compatibility](docs/provider-compatibility.md) for the transport matrix.

## Failure behavior

A proxy route is fail-closed after the plugin has initialized:

```text
proxy selected
  -> bootstrap unavailable or invalid
  -> cached signed bootstrap unavailable or outside grace
  -> model request fails
  -> no direct retry
```

An invalid or missing required configuration is retained as blocked state so the next model request fails instead of escaping directly. However, the audited OpenCode 1.18.18 loader logs an external plugin load failure and continues. If the package is absent, cannot be installed, or throws before installing its interceptor, a public plugin cannot stop OpenCode itself. Use OS/container egress controls when that stronger guarantee is required.

## Debugging

Set `KOTE_GATEWAY_LOG_LEVEL=debug` before starting OpenCode. Logs are intentionally sanitized: they may include configuration path, provider ID, route, target origin, bootstrap cache state, and gateway origin, but never authorization headers, cookies, request bodies, full URLs, query strings, or complete bootstrap documents.

Useful checks:

1. Confirm OpenCode loaded `@koteyye/kote-gateway-opencode` without an install or compatibility error.
2. Confirm the resolved configuration path and route in debug output.
3. For proxy failures, restore the signed bootstrap service or a still-valid last-known-good cache; do not expect a direct retry.
4. If `KOTE_UNSUPPORTED_TRANSPORT` appears, disable the experimental transport or use an explicitly direct route.
5. After changing configuration, restart OpenCode.

## Uninstall

Remove `@koteyye/kote-gateway-opencode` (or its tuple) from the OpenCode `plugin` array and restart OpenCode. The plugin's `dispose()` unregisters its instance and restores the captured fetch only when it is the last active instance and no later plugin has replaced the wrapper.

Configuration and bootstrap cache files are not automatically deleted. Remove them separately only if they are no longer needed.

## Security summary

- Signed bootstrap v1 is verified with the embedded Ed25519 public key before `proxy.url` is used.
- The target URL is never rewritten to a proxy API endpoint; HTTPS uses `CONNECT` without MITM or a custom CA.
- Opaque, short-lived route markers contain no provider ID, session ID, or credential.
- Proxy-specific headers, if a future descriptor supplies them, are passed only via Bun's `proxy.headers`, never target headers. The current signed v1 wire format contains no proxy-header or proxy-credential field.
- Bootstrap traffic, MCP, npm, Git, OpenCode service traffic, and arbitrary unmarked fetches are not globally proxied.
- Proxy failure never triggers a direct retry.

Read [Security](docs/security.md) and [Architecture](docs/architecture.md) for the full boundary.

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run build
bun run test:opencode
npm pack
```

Tests use synthetic transports plus local TLS target/proxy sockets; ordinary CI does not contact real AI APIs or contain OAuth credentials.
