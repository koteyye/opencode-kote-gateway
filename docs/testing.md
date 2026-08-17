# Testing

The test strategy distinguishes deterministic transport evidence from credentialed/manual E2E. Ordinary tests do not contact real AI APIs.

## Automated layers

### Unit and contract

Unit suites cover configuration, route selection, marker lifetime/capacity, bootstrap parsing/signatures/cache/singleflight, request normalization, global wrapper ownership, typed errors, and sanitized logging.

Transport contract fixtures model behavior rather than provider names:

- ordinary string/`URL`/`Request` fetch;
- a custom wrapper that calls global fetch;
- synthetic OAuth refresh/header/URL rewrite;
- signed-header handling;
- unknown-header removal;
- streaming upload and SSE response;
- abort propagation;
- detectable WebSocket/native bypass.

### Integration

`tests/integration` uses an injected captured fetch and fake gateway client. It proves, without external networking:

```text
direct marker
  -> one captured call
  -> no proxy option

proxy marker
  -> one captured call
  -> original target URL
  -> Bun proxy option contains the fake descriptor

proxy transport failure
  -> error propagates
  -> one proxied attempt
  -> zero direct attempts
```

Counters make a hidden catch-and-direct retry observable. Separate assertions ensure proxy headers are not copied into target headers and bootstrap resolution does not recurse through the installed wrapper.

These captured-fetch cases test the plugin/core boundary and final-fetch contract. A separate local network test starts a TLS target and a TLS proxy, then verifies all three paths with real sockets:

```text
direct       -> target receives the request; proxy sees no CONNECT
proxy        -> proxy sees CONNECT and its private header; target sees only provider authorization
gateway down -> typed failure; target connection count does not increase
```

The test generates a one-day localhost certificate with OpenSSL in a temporary directory and deletes it afterward. It proves Bun's HTTPS `CONNECT` behavior and zero direct fallback locally; it does not claim to validate an external gateway deployment.

### Package and compatibility smoke tests

The build/package smoke test checks emitted exports, including a strict NodeNext consumer typecheck, and the npm tarball. The OpenCode compatibility smoke then installs that tarball into an isolated temporary consumer, starts a local OpenAI-compatible provider, and runs a real non-interactive OpenCode model request. It verifies the `chat.headers` debug route decision, provider-header preservation, removal of the private route marker before the target, multi-frame SSE output, and a harmless `read` tool-call plus continuation request. A second run loads an invalid routing file and proves that `KOTE_CONFIG_INVALID` is reported without increasing the provider's request count. The temporary provider and profile are stopped and removed even when an assertion fails; no external AI API or credential is used.

Static audit rejects OpenCode internal imports and likely secret material. The declared public-API range has a 1.18.18 ceiling, and CI runs the packed-plugin model round trip against the OpenCode 1.18.5 minimum and 1.18.18 ceiling.

## Commands

Run tests from this standalone repository:

```bash
bun install
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run build
bun run package:smoke
bun run test:opencode
bun run audit
npm pack
```

`bun run check` runs lint, typecheck, all Bun tests, build, and package smoke checks.

CI runs lint, typecheck, unit tests, build, and `npm pack` on Linux, macOS, and Windows with Bun 1.3.14. Linux additionally runs integration tests, the security/import audit, and compatibility checks at both the OpenCode 1.18.5 minimum and 1.18.18 ceiling.

## Manual clean-OpenCode checklist

Use a clean OpenCode 1.18.18 profile and an npm tarball produced by `npm pack`. Keep test credentials outside the repository and redact captures.

Record evidence for:

- package installation from both string and tuple plugin configuration;
- a custom provider in direct mode;
- the same HTTP endpoint under two provider IDs with different routes;
- proxy-mode `CONNECT` through a controlled gateway;
- gateway unavailable with zero target-server connections;
- concurrent providers without route crossover;
- SSE streaming, tool calls, and cancellation;
- invalid configuration blocking a model request;
- plugin disposal/reload behavior.

Packet-level evidence should show `CONNECT` to the original provider host and no direct connection from the OpenCode process for the proxy case. Do not store target authorization or TLS-decrypted payloads in the report.

## Manual OpenAI OAuth checklist

This repository does not contain a completed real OpenAI OAuth E2E result. Synthetic tests verify wrapper ordering only. Before a release that claims live OAuth validation, an authorized operator must run and record, without committing credentials:

1. direct ChatGPT Plus/Pro login, model streaming, and tool call;
2. proxy login/model request with `CONNECT` evidence and no direct model connection;
3. token refresh through the configured auxiliary-origin route;
4. preservation of `ChatGPT-Account-Id` and the Codex URL rewrite;
5. HTTP fallback when OpenAI WebSocket mode would otherwise be selected;
6. gateway-down behavior with no direct retry.

The external browser leg is outside plugin control. Report it separately from in-process token exchange and model traffic.

## Reading results honestly

- Passing captured-fetch tests proves behavior only for traffic that reaches the controlled fetch.
- Passing synthetic OAuth tests does not prove account login, provider acceptance, or refresh against the live service.
- Passing the 1.18.18 compatibility test does not establish compatibility with later OpenCode versions.
- An unavailable plugin cannot enforce policy; full fail-closed testing requires external egress controls as a second boundary.
