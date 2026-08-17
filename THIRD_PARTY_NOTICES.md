# Third-party notices

This package reuses the Kote Gateway bootstrap protocol and client-side verification logic originally developed in KoteCode under the MIT License.

It uses [`@noble/ed25519`](https://github.com/paulmillr/noble-curves), licensed under MIT, to verify signed bootstrap documents. The production client contains only the public verification key. No private signing key is included in source, fixtures, build output, or package artifacts.

OpenCode is a separate project. This plugin is not affiliated with or endorsed by the OpenCode maintainers.
