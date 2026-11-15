# Changelog

## [0.1.53](https://github.com/therandomsecurityguy/signet/compare/v0.1.52...v0.1.53) (2026-11-15)


### Features

* no-AWS local demo (host + compose + kind) and bootstrap scope fix ([12f7b0c](https://github.com/therandomsecurityguy/signet/commit/12f7b0c6661ebef2de6f8f2648d2b8c12bcce328))
* no-AWS local demo (host + compose + kind) and bootstrap scope fix ([703e04d](https://github.com/therandomsecurityguy/signet/commit/703e04d8da02a8a315d35bc23efea82d68826e52))

## [0.1.52](https://github.com/therandomsecurityguy/signet/compare/v0.1.51...v0.1.52) (2026-11-14)


### Bug Fixes

* **scripts:** treat npm trust list empty-state as no configuration ([e6862fc](https://github.com/therandomsecurityguy/signet/commit/e6862fcc58e562eeae8ab631dd10df6a52f9f2bc))
* **scripts:** treat npm trust list empty-state as no configuration ([b617e83](https://github.com/therandomsecurityguy/signet/commit/b617e83551f30c2e19f81e5084c68d0b02e78cbf))

## [0.1.51](https://github.com/therandomsecurityguy/signet/compare/v0.1.50...v0.1.51) (2026-11-14)


### Bug Fixes

* **security:** port auth-failure budget to the MCP rate limiter ([61e9a00](https://github.com/therandomsecurityguy/signet/commit/61e9a007586b1a35c1c51dc27ce793fdc24865f2))
* **security:** port auth-failure budget to the MCP rate limiter ([2e271d3](https://github.com/therandomsecurityguy/signet/commit/2e271d307c8b819b9541cff9f45c053a26996073))

## [0.1.50](https://github.com/therandomsecurityguy/signet/compare/v0.1.49...v0.1.50) (2026-11-14)


### Bug Fixes

* **security:** per-key salt for API key hashes with legacy migration ([d0a65ad](https://github.com/therandomsecurityguy/signet/commit/d0a65ad3a884725463e05123328ee859d02375db))
* **security:** per-key salt for API key hashes with legacy migration ([7db30ea](https://github.com/therandomsecurityguy/signet/commit/7db30ea043a5d57107c1991bbde2b5885602b63d))

## [0.1.49](https://github.com/therandomsecurityguy/signet/compare/v0.1.48...v0.1.49) (2026-11-14)


### Bug Fixes

* **security:** read-gate enumeration filtering, optional metrics auth, nits ([3621bc0](https://github.com/therandomsecurityguy/signet/commit/3621bc00570a8cbaa73e6f2a50191d94371bb4a8))
* **security:** read-gate enumeration filtering, optional metrics auth, nits ([00c2270](https://github.com/therandomsecurityguy/signet/commit/00c2270b67ad1b59fbb8f3a43aaa078a8a769672))

## [0.1.48](https://github.com/therandomsecurityguy/signet/compare/v0.1.47...v0.1.48) (2026-11-14)


### Bug Fixes

* **security:** final hardening — RE2 regex, fetch, S3 TLS, mock-auth gating, release clobber ([8ff2eac](https://github.com/therandomsecurityguy/signet/commit/8ff2eacd07380b8b94ea76f55c3df9ae5cc495e4))
* **security:** MCP data-plane entitlements, auth-failure budget, query timeouts ([e494129](https://github.com/therandomsecurityguy/signet/commit/e494129e0f9ded4154ef7b9f397162710054d9e0))
* **security:** MCP data-plane entitlements, auth-failure budget, query timeouts ([836184f](https://github.com/therandomsecurityguy/signet/commit/836184f97dc1b60ce7ddf535e9229e28258aedab))
* **security:** misc lows — RE2 keyless regex, fetch hardening, S3 TLS, secrets ([612539e](https://github.com/therandomsecurityguy/signet/commit/612539ec50d9e91d5432dd7d21ed84f453f87501))
* **security:** mock-auth gating, strict read-gate flags, release asset clobber ([ef2b5e9](https://github.com/therandomsecurityguy/signet/commit/ef2b5e9f706793dba28812a05acb9499ae32bd9f))
* **security:** scope mock-auth guard to okta/dual auth selection ([12f1bb0](https://github.com/therandomsecurityguy/signet/commit/12f1bb0ffb0a4347208692afa07d6c7523433dd5))

## [0.1.47](https://github.com/therandomsecurityguy/signet/compare/v0.1.46...v0.1.47) (2026-11-14)


### Bug Fixes

* **security:** close unauthenticated governance writes and CAS traversal ([9885b19](https://github.com/therandomsecurityguy/signet/commit/9885b19142f2131956f71f87e04b2259b80d79b7))
* **security:** close unauthenticated governance writes and CAS traversal ([3f88566](https://github.com/therandomsecurityguy/signet/commit/3f88566c07d64c2f87d8b9e02a30668f6b0a5103))
* **security:** harden webapp sessions (admin gates + CSRF) ([1889a75](https://github.com/therandomsecurityguy/signet/commit/1889a75b3a86faadf408d84c2e2eaab649c70daf))
* **security:** harden webapp sessions (admin gates + CSRF) ([3a70a04](https://github.com/therandomsecurityguy/signet/commit/3a70a046e5d237589d7a1fa13e22be9b0868ae61))

## [0.1.46](https://github.com/therandomsecurityguy/signet/compare/v0.1.45...v0.1.46) (2026-11-14)


### Bug Fixes

* **infra:** migrate signet-eks to Helm provider v3 ([e047b18](https://github.com/therandomsecurityguy/signet/commit/e047b18fc855c0b65aa15582dcf25b03c2b26758))

## [0.1.45](https://github.com/therandomsecurityguy/signet/compare/v0.1.44...v0.1.45) (2026-11-14)


### Bug Fixes

* **ci:** run release-please with the default GITHUB_TOKEN ([67d23d3](https://github.com/therandomsecurityguy/signet/commit/67d23d3dae0c811e840106b84ca796ec6254f736))
* update url-encoded urn expectations to sg ([b08e013](https://github.com/therandomsecurityguy/signet/commit/b08e01316cf29ec86b870d098cfa7d70141a79a7))

## Changelog

All notable changes to Signet are documented in this file.

This file starts fresh at the signet rename; prior release history was
kept outside this repository. Release entries are generated by
release-please from conventional commits on `main`.
