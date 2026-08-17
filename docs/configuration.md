# Configuration

KoteGateway routing is configured independently of `opencode.json`. OpenCode's file only installs the plugin; the KoteGateway file defines policy.

## Selecting the file

The first available source wins:

1. `KOTE_GATEWAY_CONFIG`;
2. plugin tuple option `configPath`;
3. platform default.

Relative paths are resolved by the runtime, `~` is expanded to the user's home directory, and environment selection takes precedence when both environment and tuple option are present. The debug log reports that precedence without printing file contents.

| Platform | Default |
| --- | --- |
| Linux with `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/kote-gateway/config.json` |
| Linux otherwise | `~/.config/kote-gateway/config.json` |
| macOS | `~/.config/kote-gateway/config.json` |
| Windows | `%APPDATA%\\KoteGateway\\config.json` |

Restart OpenCode after changing the file. Version 1 is loaded as immutable configuration and does not hot reload.

The verified bootstrap cache is independent of the routing file and uses the standalone package namespace:

| Platform | Bootstrap cache |
| --- | --- |
| Linux | `$XDG_CACHE_HOME/kote-gateway/bootstrap.json`, otherwise `~/.cache/kote-gateway/bootstrap.json` |
| macOS | `~/Library/Caches/KoteGateway/bootstrap.json` |
| Windows | `%LOCALAPPDATA%\\KoteGateway\\bootstrap.json`, with `%APPDATA%` as fallback |

The cache is a signed last-known-good bootstrap, not an OAuth or API-key store.

## Schema version 1

```json
{
  "version": 1,
  "default": "proxy",
  "strict": true,
  "providers": {
    "openai": "proxy",
    "company-openai-compatible": "proxy",
    "local-model": "direct"
  },
  "auxiliaryOrigins": {
    "company-openai-compatible": [
      "https://login.example.org"
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Required integer `1`. Unknown versions are rejected. |
| `default` | Required `direct` or `proxy`; used for every provider ID absent from `providers`. |
| `strict` | Selects strict handling of unknown local configuration fields. It does not weaken routing, correlation, transport, or no-fallback guards. |
| `providers` | Required object mapping arbitrary, non-empty provider IDs to `direct` or `proxy`. |
| `auxiliaryOrigins` | Optional mapping from provider ID to bare HTTP(S) origins used for in-process auth/support traffic without a model marker. |

Provider IDs are exact and case-sensitive. They are not derived from hostname, model name, SDK package, or authentication type. Two IDs with the same `baseURL` can therefore use different routes.

Unknown provider IDs use `default` without a plugin update:

```text
providers contains selected ID -> explicit route
otherwise                     -> default route
```

## Validation

The loader rejects:

- malformed JSON or a non-object root;
- missing/unknown `version`;
- route values other than `direct` and `proxy`;
- empty provider IDs;
- non-array auxiliary entries;
- non-HTTP(S) auxiliary URLs;
- origins with username, password, path, query, or fragment;
- one origin assigned to provider IDs whose resolved routes conflict;
- an auxiliary origin equal to the bootstrap origin.

With `strict: true`, unknown top-level fields are rejected. With `strict: false`, they are ignored with a sanitized warning. Regardless of that setting, known fields are validated and proxy transport failures remain fail-closed.

An origin is normalized before indexing. For example, `https://example.com:443/` becomes `https://example.com`; `/oauth/token` is not permitted because matching deliberately operates at origin scope.

When configuration cannot be accepted, an initialized plugin records blocked state. A later model request fails with a sanitized `KOTE_CONFIG_*` error and does not become a direct request merely because parsing failed.

## Route semantics

### Direct

```text
provider wrapper -> captured nextFetch -> provider
```

Direct does not bootstrap, set a proxy option, rewrite the target URL, or use KoteGateway as a fallback.

### Proxy

```text
provider wrapper
  -> signed bootstrap / verified LKG
  -> captured nextFetch with Bun proxy option
  -> CONNECT tunnel
  -> original provider
```

Bootstrap, proxy connection, and provider errors propagate. No catch branch repeats the request without the proxy.

## Auxiliary origins

Model requests normally carry an opaque route marker. Auxiliary matching exists for in-process requests such as OAuth exchange and refresh that occur without that marker.

Keep the set minimal. An entry routes every in-process fetch to that origin using the named provider's route, regardless of path. It does not affect the external browser, MCP, npm, Git, update checks, another origin, or a client that bypasses fetch.

The OpenAI OAuth implementation audited in OpenCode 1.18.18 uses:

- `https://auth.openai.com` for authorization/token/device endpoints;
- `https://chatgpt.com` for the Codex model endpoint;
- `https://api.openai.com` for ordinary API-key endpoints.

Those three OpenAI origins are built in and merged automatically; users do not need to repeat them. Configuration may add more origins for OpenAI or other provider IDs.

## Logging

Set `KOTE_GATEWAY_LOG_LEVEL` to `error`, `warn`, `info`, or `debug`. Debug output is for routing diagnostics and remains sanitized. It never includes authorization/proxy-authorization values, cookies, bodies, full target URLs, query strings, or signed bootstrap contents.

## Bootstrap configuration is separate

The local routing file is not the signed remote bootstrap. The remote v1 document is fixed to:

```json
{
  "config_version": 1,
  "proxy": { "url": "https://proxy.example" },
  "issued_at": "...",
  "expires_at": "...",
  "signature": "..."
}
```

Its exact verification contract is in [Reconnaissance](reconnaissance.md). Do not add provider routes or credentials to that document. The compatible parser ignores extra fields and consumes only the signed known projection, so extensions cannot change routing behavior without a new schema version and client release.
