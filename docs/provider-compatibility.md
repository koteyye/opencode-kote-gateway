# Provider transport compatibility

Compatibility is determined by the transport path, not the provider name. There is no built-in provider allowlist.

## Matrix

| Transport class | Direct | Proxy | Evidence / boundary |
| --- | --- | --- | --- |
| AI SDK HTTP using the process fetch | Pass-through | Routed | Synthetic captured-fetch contract tests verify marker removal and Bun proxy option. |
| Provider-specific wrapper that calls patched global fetch | Pass-through | Routed | Verified pattern in OpenCode 1.18.18 custom wrappers; synthetic auth/rewrite/signing chains cover ordering. |
| OAuth wrapper whose final model request calls global fetch | Pass-through | Routed | OpenAI 1.18.18 adds bearer/account headers and rewrites URL before its HTTP call. |
| Unmarked OAuth/token HTTP to an exact configured auxiliary origin | Pass-through or routed by provider policy | Routed | Exact-origin registry; browser navigation is excluded. |
| URL-rewriting HTTP wrapper | Pass-through | Routed | Interceptor retains the rewritten target and applies proxy separately. |
| SigV4-like signed HTTP request | Pass-through | Routed | Marker is removed only when not signed; opaque marker is preserved if listed in signed headers. |
| `Request` input, streaming upload, SSE response, abort signal | Pass-through | Routed | Contract tests do not consume the body or buffer the response. |
| Custom fetch that captured an older transport before plugin initialization | Unknown | Not guaranteed | Public API cannot replace it without risking provider-specific behavior. |
| Wrapper that removes the marker and rewrites to another configured auxiliary origin | Ambiguous | Not guaranteed | The final request is indistinguishable from legitimate unmarked auxiliary traffic; use a dedicated transport contract or host egress policy. |
| Custom HTTP library that never calls global fetch | Unchanged | Not guaranteed | Requires a dedicated contract test or external network policy. |
| OpenAI 1.18.18 built-in WebSocket | Unchanged | HTTP fallback requested | Uses the version-pinned internal `x-opencode-title` behavior; public hooks cannot confirm it was honored. |
| Arbitrary WebSocket / raw socket / QUIC | Unchanged | Blocked only when detectable; otherwise not guaranteed | No public arbitrary-socket interception hook. |
| Experimental native LLM selected by visible env flag | OpenCode-owned | Rejected | Native transport is not exposed through the public plugin API. |
| Native runtime enabled through an unobservable programmatic override | OpenCode-owned | Not guaranteed | Requires host egress policy for enforcement. |

“Routed” means the observed final request is passed once to the captured fetch with Bun's per-request proxy option. It does not mean that an external live provider or OAuth account was used in CI.

## OpenCode 1.18.18 audit

OpenCode's provider registry at `2cba7e227d68a7e7e4a2aa9c85b808e8ecb14daf` constructs bundled SDKs for the following package families:

- AI SDK HTTP providers such as OpenAI, Anthropic, Azure, Google/Vertex, Amazon Bedrock, xAI, Mistral, Groq, Cohere, and OpenAI-compatible transports;
- third-party AI SDK providers such as OpenRouter, GitLab, GitHub Copilot, and Venice;
- dynamically installed custom packages whose exported factory is selected at runtime.

OpenCode injects an `options.fetch` wrapper into provider SDK construction. With normal initialization ordering, this wrapper captures the already-patched process fetch unless an earlier custom function was supplied. This gives broad fetch-based coverage without a provider-ID list.

Observed special cases:

| Audited path | Behavior before final transport | Result |
| --- | --- | --- |
| OpenAI API key over AI SDK HTTP | SDK headers and Responses/chat endpoint selection | Reaches captured fetch in the ordinary HTTP path. |
| OpenAI ChatGPT OAuth HTTP | Refresh when expired, set bearer and `ChatGPT-Account-Id`, rewrite to ChatGPT Codex endpoint | Reaches interceptor after transformations. Real credential E2E is not claimed. |
| OpenAI ChatGPT OAuth WebSocket | `ws` pool may open a socket before HTTP | Proxy route requests the audited 1.18.18 HTTP fallback; the supported range must not expand without retesting. |
| Google Vertex custom fetch | Obtain Google access token, set `Authorization`, then call global fetch | Reaches interceptor after auth in the audited implementation. |
| Snowflake custom fetch | Transform request, call global fetch, normalize a response edge case | Reaches interceptor around the network call in the audited implementation. |
| Signed cloud request | Provider SDK may sign all declared headers | Opaque marker is retained if signature metadata declares it signed. |
| Dynamic custom SDK | Package-defined | Compatible only if its final network operation uses the controlled fetch path. |
| Native LLM | Effect HTTP client / provider override internal to OpenCode | Not a public seam; proxy selection is rejected when the visible flag enables it. |

This table is an audit of transport code, not a promise that every model, account, region, or provider API is operational.

## Adding or upgrading a provider

A new `providerID` needs no source change when it uses a verified HTTP/fetch class. Add an explicit route only if it should differ from `default`, and add auxiliary origins only for unmarked in-process traffic.

Before relying on proxy enforcement:

1. verify the SDK does not open a WebSocket/native socket for the chosen mode;
2. run a captured-fetch contract test proving provider transforms occur before interception;
3. verify that a URL-rewriting wrapper preserves the marker, or that its final origin cannot collide with another provider's auxiliary policy;
4. make the captured transport fail and assert there is exactly one call with a proxy option and zero direct attempts;
5. test streaming and cancellation without buffering;
6. if authorization has unmarked fetches, register the smallest exact origin set;
7. use external egress policy when the transport cannot be observed.

OpenCode upgrades must rerun the public-hook and OpenAI HTTP-fallback compatibility checks before widening the supported peer range.
