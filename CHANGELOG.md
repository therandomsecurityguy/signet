# Changelog

## [0.1.71](https://github.com/therandomsecurityguy/signet/compare/v0.1.70...v0.1.71) (2026-11-19)


### Features

* **tessera-sidecar:** spec note-mode checkpoint signing (PR B) ([e801619](https://github.com/therandomsecurityguy/signet/commit/e8016199c0205ef82ec7b20ce81a521c147d0439))
* **tessera-sidecar:** spec note-mode checkpoint signing (PR B) ([b778a6f](https://github.com/therandomsecurityguy/signet/commit/b778a6f50a44d44718a7c1143095d1e78c9009b1))


### Bug Fixes

* **registry:** cut only the first two '+' separators when parsing note verifier keys ([d7864b9](https://github.com/therandomsecurityguy/signet/commit/d7864b97e1aae67426a41f799146ee8e7d7caad2))
* **registry:** parse note verifier keys with '+' in base64 key data ([70f64e9](https://github.com/therandomsecurityguy/signet/commit/70f64e95eb03a5a9c93bd9f119e9a1aa56dc985f))

## [0.1.70](https://github.com/therandomsecurityguy/signet/compare/v0.1.69...v0.1.70) (2026-11-19)


### Features

* **registry:** transparency-dev spec signed-note verification (PR A) ([df21075](https://github.com/therandomsecurityguy/signet/commit/df2107512c58d957828fff3f4fc28d21e8599e5d))
* **registry:** transparency-dev spec signed-note verification (PR A) ([bb3f809](https://github.com/therandomsecurityguy/signet/commit/bb3f809e9808b6480d95017cf11b9d3cd6566e92))

## [0.1.69](https://github.com/therandomsecurityguy/signet/compare/v0.1.68...v0.1.69) (2026-11-19)


### Features

* **registry:** ontology-aware SHACL validation + de-facto promotion into authored OWL ([ca309f3](https://github.com/therandomsecurityguy/signet/commit/ca309f34b7c739adea80360b35bfe25a050ee5ed))
* **registry:** ontology-aware SHACL validation + de-facto promotion into authored OWL ([44bd8ad](https://github.com/therandomsecurityguy/signet/commit/44bd8ade2aa2bcbbb8bc97c3407d0f9bc245cfe2))

## [0.1.68](https://github.com/therandomsecurityguy/signet/compare/v0.1.67...v0.1.68) (2026-11-18)


### Features

* **shacl-runtime:** subprocess isolation with rlimits and hard cancellation ([8c3a8d6](https://github.com/therandomsecurityguy/signet/commit/8c3a8d6c651ec43b8f8ba567ddfc9b8c4b91309c))
* **shacl-runtime:** subprocess isolation with rlimits and hard cancellation ([165c8cd](https://github.com/therandomsecurityguy/signet/commit/165c8cd40c14556a13d85e06f3328ee05f86a445))

## [0.1.67](https://github.com/therandomsecurityguy/signet/compare/v0.1.66...v0.1.67) (2026-11-18)


### Features

* **registry:** execute SHACL-AF policies via the pyshacl runtime sidecar ([06180f7](https://github.com/therandomsecurityguy/signet/commit/06180f7a25c3b6b92085bcc2ebb0c03924bdc7ce))

## [0.1.66](https://github.com/therandomsecurityguy/signet/compare/v0.1.65...v0.1.66) (2026-11-18)


### Features

* **shacl-runtime:** SHACL-AF runtime sidecar (pyshacl advanced features) ([3f1edb5](https://github.com/therandomsecurityguy/signet/commit/3f1edb5df1ca5b0144c38a86ac09a1704bacd43b))
* **shacl-runtime:** SHACL-AF runtime sidecar (pyshacl advanced features) ([47aac6c](https://github.com/therandomsecurityguy/signet/commit/47aac6c181357806863d81f0b8155b6b24b950d9))


### Bug Fixes

* **shacl-runtime:** harden against SSRF, slowloris, queue exhaustion + dev-dep audit ([650eb26](https://github.com/therandomsecurityguy/signet/commit/650eb2626020baef063902d3fdcbc003d0f122b4))

## [0.1.65](https://github.com/therandomsecurityguy/signet/compare/v0.1.64...v0.1.65) (2026-11-17)


### Features

* **registry:** authored OWL Turtle ontology packages ([8edc2e9](https://github.com/therandomsecurityguy/signet/commit/8edc2e9c915261642864e37fe8bb665d3cd08ea9))
* **registry:** authored OWL Turtle ontology packages (RDF/OWL) ([7e486d5](https://github.com/therandomsecurityguy/signet/commit/7e486d5e8d1b7bb2c90a565ff702800c825144b6))

## [0.1.64](https://github.com/therandomsecurityguy/signet/compare/v0.1.63...v0.1.64) (2026-11-17)


### Features

* **registry:** SPARQL constraints and SPARQL-based targets (SHACL-SPARQL) ([a8832b5](https://github.com/therandomsecurityguy/signet/commit/a8832b5a508748c08589f47748aa850ede870a40))

## [0.1.63](https://github.com/therandomsecurityguy/signet/compare/v0.1.62...v0.1.63) (2026-11-17)


### Features

* **registry:** signed validation reports + evidence transparency docs (PR B) ([983ebc9](https://github.com/therandomsecurityguy/signet/commit/983ebc9ef27f6246198c9828db70d36aa3198ed4))
* **registry:** signed validation reports + evidence transparency docs (PR B) ([e2e746e](https://github.com/therandomsecurityguy/signet/commit/e2e746ee017bdd7f19a7268050743611af10bf71))


### Bug Fixes

* **cli:** enforce trusted-key status + validity window before using key pems ([c888ae9](https://github.com/therandomsecurityguy/signet/commit/c888ae947c73ba5438cccd206d3b0d661813d648))

## [0.1.62](https://github.com/therandomsecurityguy/signet/compare/v0.1.61...v0.1.62) (2026-11-17)


### Features

* **registry:** transparency append intents for evidence artifacts (PR A) ([3b24280](https://github.com/therandomsecurityguy/signet/commit/3b24280d14a5ef0354c72ea37c3bcad6740de7ed))
* **registry:** transparency append intents for evidence artifacts (PR A) ([76bdc6c](https://github.com/therandomsecurityguy/signet/commit/76bdc6c819151e97def3b86199c51d9667b84ff9))

## [0.1.61](https://github.com/therandomsecurityguy/signet/compare/v0.1.60...v0.1.61) (2026-11-17)


### Features

* **registry:** validation reports as standardized RDF + docs pass ([4210651](https://github.com/therandomsecurityguy/signet/commit/4210651310883c6d9da4f65a14d9934955325dbb))
* **registry:** validation reports as standardized RDF + docs pass (PR 3/3) ([d029cd0](https://github.com/therandomsecurityguy/signet/commit/d029cd0e28cbffa71482499260d30c5833a3a356))

## [0.1.60](https://github.com/therandomsecurityguy/signet/compare/v0.1.59...v0.1.60) (2026-11-16)


### Features

* **registry:** detached provenance signatures with valid/invalid/stale verdicts (PR 2/3) ([1bd5759](https://github.com/therandomsecurityguy/signet/commit/1bd5759557b181878cf26fa3eac5d2c06a8b1681))


### Bug Fixes

* **cli:** drop redundant catch assignments flagged by no-useless-assignment ([91ce26f](https://github.com/therandomsecurityguy/signet/commit/91ce26f35ece8587918d62109154c4c5fde97831))

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
