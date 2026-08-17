# Repository instructions

- This repository is the standalone `@koteye/kote-gateway-opencode` package. Do not patch or import OpenCode internals.
- Keep `src/core` independent of OpenCode. Only `src/opencode` and `src/server.ts` may reference the public `@opencode-ai/plugin` package.
- Preserve the signed bootstrap wire format documented in `docs/reconnaissance.md`.
- Proxy routes are fail-closed. Never add a proxy-to-direct fallback.
- Do not log credentials, request bodies, full target URLs, query strings, or complete bootstrap documents.
- Use Bun APIs where practical, avoid `any`, prefer `const`, early returns, and functional collection methods.
- Run `bun run check` before committing.

Branches use at most three hyphen-separated words. Commits and pull requests use `type(scope): summary`.
