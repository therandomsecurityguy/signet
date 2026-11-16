# Changelog

## [0.1.59](https://github.com/therandomsecurityguy/signet/compare/v0.1.58...v0.1.59) (2026-11-16)


### Features

* **registry:** canonical provenance export with JSON-LD and RDFC-1.0 digest ([57cc115](https://github.com/therandomsecurityguy/signet/commit/57cc115fe1497a96e5f5bb194f0be29354530d9f))
* **registry:** canonical provenance export with JSON-LD and RDFC-1.0 digest (PR 1/3) ([d46771a](https://github.com/therandomsecurityguy/signet/commit/d46771abc1f65e75c9a68fab8545dbde155c9b04))

## [0.1.58](https://github.com/therandomsecurityguy/signet/compare/v0.1.57...v0.1.58) (2026-11-16)


### Features

* **webapp:** captioned demo-video recording script ([02d5309](https://github.com/therandomsecurityguy/signet/commit/02d530973afa28c71b4740bd511072454526e6ef))
* **webapp:** demo video with terminal + browser segments ([7c0b23e](https://github.com/therandomsecurityguy/signet/commit/7c0b23ee370e0a92ae22740ecbc3fd64ded5b1ec))
* **webapp:** terminal segment for the demo video (+ lifecycle badge polish) ([2733fe0](https://github.com/therandomsecurityguy/signet/commit/2733fe0bb81e48b0094335a2efb575dbe6f79da7))

## [0.1.57](https://github.com/therandomsecurityguy/signet/compare/v0.1.56...v0.1.57) (2026-11-16)


### Features

* **api:** authored W3C SHACL Turtle policy packages (PR 2/3) ([35cdc4d](https://github.com/therandomsecurityguy/signet/commit/35cdc4d6bd826f7426054b1992eee1741ba1ffe6))

## [0.1.56](https://github.com/therandomsecurityguy/signet/compare/v0.1.55...v0.1.56) (2026-11-16)


### Features

* **registry:** execute publication validation as W3C SHACL ([d50806f](https://github.com/therandomsecurityguy/signet/commit/d50806f34e68e272463fe1225232e70ece8b9257))
* **registry:** execute publication validation as W3C SHACL (PR 1/3) ([bf70010](https://github.com/therandomsecurityguy/signet/commit/bf70010c271ffc40e9160e81af4c6773920773a4))

## [0.1.55](https://github.com/therandomsecurityguy/signet/compare/v0.1.54...v0.1.55) (2026-11-15)


### Bug Fixes

* **ci:** Go toolchain 1.26.11 (net/http GO-2026-6859) and builder image bump ([77144d2](https://github.com/therandomsecurityguy/signet/commit/77144d25fcc7f9d85b56274f0bcacd72aa54026e))

## [0.1.54](https://github.com/therandomsecurityguy/signet/compare/v0.1.53...v0.1.54) (2026-11-15)


### Bug Fixes

* local-k8s smoke-test findings - shared CAS, session DB, sqlite3 glibc ([ffc8b08](https://github.com/therandomsecurityguy/signet/commit/ffc8b08620be4d9c517abf60dd565b916300d362))
* local-k8s smoke-test findings (OrbStack) — shared CAS, session DB, sqlite3 glibc ([6f3850e](https://github.com/therandomsecurityguy/signet/commit/6f3850e768b9bd2c5e2bdd101a69353402b458e9))

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
