# Changelog

## [0.1.44](https://github.com/therandomsecurityguy/cachet/compare/v0.1.43...v0.1.44) (2026-11-13)


### Bug Fixes

* **webapp:** graph default root resolution + root suggestions ([4dd62fb](https://github.com/therandomsecurityguy/cachet/commit/4dd62fbba7709d247d16f75346c7e3f3d26a655b))
* **webapp:** resolve the graph default root dynamically, suggest roots when missing ([6ca7411](https://github.com/therandomsecurityguy/cachet/commit/6ca74118d69d29ec9d47a04371001c7813f2d3e3))

## [0.1.43](https://github.com/therandomsecurityguy/cachet/compare/v0.1.42...v0.1.43) (2026-11-12)


### Features

* **infra:** optional read-only CI role for ECR (cosign verification from other repos) ([7099706](https://github.com/therandomsecurityguy/cachet/commit/7099706d94b203e4e45163b15adee7c16e0c06f5))

## [0.1.42](https://github.com/therandomsecurityguy/cachet/compare/v0.1.41...v0.1.42) (2026-11-12)


### Features

* **cli:** sign keyless --agent for deployment snapshots ([d70722c](https://github.com/therandomsecurityguy/cachet/commit/d70722ce2442138e5b2f9f440267c6316117a1ec))
* **cli:** sign keyless --agent for deployment snapshots ([58a2bbc](https://github.com/therandomsecurityguy/cachet/commit/58a2bbcbfb7e57ccc9bc2ed2d1a8eaa5b2447359))

## [0.1.41](https://github.com/therandomsecurityguy/cachet/compare/v0.1.40...v0.1.41) (2026-11-12)


### Features

* **ontology:** registry-native ontology page + ontologies:write scope ([8bc7220](https://github.com/therandomsecurityguy/cachet/commit/8bc7220fa2a04b8c446935f6cf4227562e6c9088))
* **ontology:** registry-native ontology page + ontologies:write scope ([1d6491c](https://github.com/therandomsecurityguy/cachet/commit/1d6491c79058e04aa137f3590d734914c0369a99))

## [0.1.40](https://github.com/therandomsecurityguy/cachet/compare/v0.1.39...v0.1.40) (2026-11-12)


### Bug Fixes

* **registry:** deterministic governance artifact ordering for prepared publications ([9cf3e9a](https://github.com/therandomsecurityguy/cachet/commit/9cf3e9a3d74950d9b1e453cdf77e54bad9095af4))
* **registry:** deterministic governance artifact ordering for prepared publications ([a3dec13](https://github.com/therandomsecurityguy/cachet/commit/a3dec13bc91f86ca7d112e0074192653c398f5a3))

## [0.1.39](https://github.com/therandomsecurityguy/cachet/compare/v0.1.38...v0.1.39) (2026-11-12)


### Features

* **keyless:** bundle sigstore trust anchors and verify keyless bundles in mcp ([9e925ae](https://github.com/therandomsecurityguy/cachet/commit/9e925ae7ca0e793455eb350835bfa099747f29a6))


### Bug Fixes

* **webapp:** surface Okta authorization errors instead of invalid-state ([dd524d8](https://github.com/therandomsecurityguy/cachet/commit/dd524d8504dbe74f085e6c474e873384cc6dcec8))

## [0.1.38](https://github.com/therandomsecurityguy/cachet/compare/v0.1.37...v0.1.38) (2026-11-10)


### Bug Fixes

* **chart:** use matchLabels in the default DNS selectors ([1ffcf26](https://github.com/therandomsecurityguy/cachet/commit/1ffcf26a73890cd4f66d1fdd288c73e17bac2ab6))

## [0.1.37](https://github.com/therandomsecurityguy/cachet/compare/v0.1.36...v0.1.37) (2026-11-04)


### Features

* **backup:** daily Fuseki graph backup and missing-day alarm ([d651a55](https://github.com/therandomsecurityguy/cachet/commit/d651a5595240fb89b6b108a9e85fd4306d712c54))

## [0.1.36](https://github.com/therandomsecurityguy/cachet/compare/v0.1.35...v0.1.36) (2026-11-02)


### Features

* **auth:** fine-grained API-key write scopes with warn mode ([5f95698](https://github.com/therandomsecurityguy/cachet/commit/5f9569831b0d46185b6957e68817f06e86875628))


### Bug Fixes

* **mcp:** clear SCA advisories (follow-redirects, glob, minimatch) ([c4c933c](https://github.com/therandomsecurityguy/cachet/commit/c4c933c4ff59811348636a2aead5aca1c9d50e9f))

## [0.1.35](https://github.com/therandomsecurityguy/cachet/compare/v0.1.34...v0.1.35) (2026-10-30)


### Features

* **chart:** per-component replicas + per-component PDBs for api/mcp ([95bb0c2](https://github.com/therandomsecurityguy/cachet/commit/95bb0c2451d36f520bfba0c4dbabd94b3a59b673))

## [0.1.34](https://github.com/therandomsecurityguy/cachet/compare/v0.1.33...v0.1.34) (2026-10-30)


### Features

* **transparency:** sidecar fetch timeouts + bounded retries; ops runbooks ([1106bbe](https://github.com/therandomsecurityguy/cachet/commit/1106bbe0bca6cc01291314ecfbc88dbd9b43a7c7))

## [0.1.33](https://github.com/therandomsecurityguy/cachet/compare/v0.1.32...v0.1.33) (2026-10-28)


### Features

* **alerting:** in-cluster sidecar watchdog + alarm + netpol allowance ([13a531d](https://github.com/therandomsecurityguy/cachet/commit/13a531d84f6292b402f2182669d70710bbbc8d0c))
* **infra:** data-plane alarms + external health checks in cachet-data ([71e17f7](https://github.com/therandomsecurityguy/cachet/commit/71e17f73be1e7e5058e6a7023eb66473d5d4cbc4))


### Bug Fixes

* **infra:** encrypt the alerts SNS topic (SSE, AWS-managed key) ([daa9068](https://github.com/therandomsecurityguy/cachet/commit/daa906884c6d52ccc7de8630989c4ef6c33cc043))

## [0.1.32](https://github.com/therandomsecurityguy/cachet/compare/v0.1.31...v0.1.32) (2026-10-27)


### Bug Fixes

* **otel:** restore exporter 0.223 in api/mcp and add boot smoke to CI ([766f5f5](https://github.com/therandomsecurityguy/cachet/commit/766f5f52233e8ac9ae01321870d5bd493efd067e))

## [0.1.31](https://github.com/therandomsecurityguy/cachet/compare/v0.1.30...v0.1.31) (2026-10-27)


### Bug Fixes

* **images:** ship registry runtime deps in the api/mcp images ([bb6e983](https://github.com/therandomsecurityguy/cachet/commit/bb6e983c79af2de9482745b43dc088ede9dce1af))

## [0.1.30](https://github.com/therandomsecurityguy/cachet/compare/v0.1.29...v0.1.30) (2026-10-27)


### Bug Fixes

* **api:** exclude tests from the production build so the image needs no test-only sources ([2b3422b](https://github.com/therandomsecurityguy/cachet/commit/2b3422bf5773cf129af6447c3b2fa482783da267))

## [0.1.29](https://github.com/therandomsecurityguy/cachet/compare/v0.1.28...v0.1.29) (2026-10-26)


### Features

* **cli:** keyless (sigstore) signing for CI (Phase 3 Stage B) ([e00501b](https://github.com/therandomsecurityguy/cachet/commit/e00501b5fdfefe40af700da55773a1800b25f17f))
* **registry:** keyless (sigstore) publication signature verification (Phase 3 Stage A) ([02a4ff0](https://github.com/therandomsecurityguy/cachet/commit/02a4ff01c86b03b59f72d137b90fca83bb053882))
* **registry:** keyless (sigstore) publication signature verification (Phase 3 Stage A) ([67268c9](https://github.com/therandomsecurityguy/cachet/commit/67268c9f685aaef7cf88606521349658ea56b0d6))
* **registry:** verify Rekor transparency entries and anchor keyless validity at the attested time ([5267dcd](https://github.com/therandomsecurityguy/cachet/commit/5267dcd03e41d0181be6497cf08e1999e3058cbe))
* **transparency:** native RFC 6962 companion log + registry reconciliation (Phase 4) ([882f5e4](https://github.com/therandomsecurityguy/cachet/commit/882f5e429c7c28a4b22745be77b2d3b7549aa92b))


### Bug Fixes

* **cli:** patch dependency advisories surfaced by the sigstore install rescan ([d47715f](https://github.com/therandomsecurityguy/cachet/commit/d47715fd6a5094240e9e177e75454b47cacb9566))
* **cli:** verify publication accepts keyless signatures and reports their verdict ([8190522](https://github.com/therandomsecurityguy/cachet/commit/8190522ce21caf2f1e1d4b47ef68aebfcbe033db))
* **registry:** anchor keyless certificate validity at registry-witnessed attach time ([b541299](https://github.com/therandomsecurityguy/cachet/commit/b54129907227ac3f8b5ba19fd73124842fa5f8ca))
* **registry:** fail closed on keyless bundles without signed payload bytes ([64185cd](https://github.com/therandomsecurityguy/cachet/commit/64185cdfc4c96d6a926566b10f7ccc0b416951b7))
* **registry:** verify Rekor SETs whenever present and authenticate the validity anchor ([2ead12f](https://github.com/therandomsecurityguy/cachet/commit/2ead12f62e2ac2b5872555da4f2ab85b6baedcb3))
* **sidecar:** bearer auth for /v1/* and registry token passthrough ([36ce028](https://github.com/therandomsecurityguy/cachet/commit/36ce028145fff134e69c65bbeab53fd163ef2219))
* **sidecar:** confine native-log record reads to the requests prefix ([47d97ae](https://github.com/therandomsecurityguy/cachet/commit/47d97ae69b3d013a1b2defe00034f73eb232eb70))
* **sidecar:** fail closed on /v1/* when sidecar auth is not configured ([7196236](https://github.com/therandomsecurityguy/cachet/commit/7196236e6ea8f8711f3db09c08a6a9b6a88883a3))
* **webapp:** bump zod to 4.6.7 (security patched range) ([f63b22b](https://github.com/therandomsecurityguy/cachet/commit/f63b22bb22c9f9cf1cab004b8d1a6829fee125c0))

## [0.1.28](https://github.com/therandomsecurityguy/cachet/compare/v0.1.27...v0.1.28) (2026-10-24)


### Bug Fixes

* **api:** require write auth on /v1/advisories ([5a1ce0a](https://github.com/therandomsecurityguy/cachet/commit/5a1ce0aec0ae78e0def3155e2ad2b026d018d944))
* **api:** require write auth on /v1/advisories (security) ([9205afc](https://github.com/therandomsecurityguy/cachet/commit/9205afcdcc5f3e7d5c8cab2eb4d828f8b316219f))

## [0.1.27](https://github.com/therandomsecurityguy/cachet/compare/v0.1.26...v0.1.27) (2026-10-23)


### Features

* **cli:** seal seeded skills with single-request sign-then-publish ([60a491b](https://github.com/therandomsecurityguy/cachet/commit/60a491b70eb957244ab0e3df4321e15a3701f5ad))

## [0.1.26](https://github.com/therandomsecurityguy/cachet/compare/v0.1.25...v0.1.26) (2026-10-23)


### Features

* **registry:** land the M4 policy-driven publication trust gates on main ([5471b6d](https://github.com/therandomsecurityguy/cachet/commit/5471b6d40c7adbf584803e7a1eeab7ed6279c32d))
* **registry:** policy-driven publication trust gates (M4 / WS2.1, WS2.2, WS2.4) ([3f39097](https://github.com/therandomsecurityguy/cachet/commit/3f39097b8a7b298dc16ad85010aca72d96a36e00))
* **registry:** single-request sign-then-publish (Phase 1) ([9e0d2b2](https://github.com/therandomsecurityguy/cachet/commit/9e0d2b2184d4a9fcda13964e12011ea41ce4ed09))
* **registry:** single-request sign-then-publish (Phase 1) ([70b3cfe](https://github.com/therandomsecurityguy/cachet/commit/70b3cfe418955631cf3a56f26d2937962e50d2f2))

## [0.1.25](https://github.com/therandomsecurityguy/cachet/compare/v0.1.24...v0.1.25) (2026-10-21)


### Bug Fixes

* **mcp:** override follow-redirects to 1.16.1 (GHSA-8r9p-f939-6h3c) ([d6f35ed](https://github.com/therandomsecurityguy/cachet/commit/d6f35ed54f8039d1adcd2fc737e92fc35ab9e587))
* **persistence:** back postgres DATABASE_URL with a real Postgres adapter ([714fd60](https://github.com/therandomsecurityguy/cachet/commit/714fd60f1ea590e15cd7a119ac48a321fde23987))
* **persistence:** back postgres DATABASE_URL with a real Postgres adapter ([3ec4be2](https://github.com/therandomsecurityguy/cachet/commit/3ec4be230356074e3aabb65fa50843250c20eec8))
* **security:** verified Postgres TLS via the RDS regional CA bundle ([c7ae137](https://github.com/therandomsecurityguy/cachet/commit/c7ae13722e4c8ff63960ab1ade797ee56f5596b9))

## [0.1.24](https://github.com/therandomsecurityguy/cachet/compare/v0.1.23...v0.1.24) (2026-10-21)


### Bug Fixes

* **mcp:** surface ARTIFACT_DIGEST_MISMATCH instead of a generic internal error ([b471593](https://github.com/therandomsecurityguy/cachet/commit/b471593a3163b4ded169c2825cdab9afd517280c))
* **mcp:** surface ARTIFACT_DIGEST_MISMATCH on enforced CAS reads ([7b3005f](https://github.com/therandomsecurityguy/cachet/commit/7b3005f16ef6bbe6001239d2f0260fe4e746ff52))

## [0.1.23](https://github.com/therandomsecurityguy/cachet/compare/v0.1.22...v0.1.23) (2026-10-21)


### Features

* **cli:** real demo signing + verify-then-load docs (supply chain M5 / WS3.3) ([34cf841](https://github.com/therandomsecurityguy/cachet/commit/34cf841fe9ade352daf27bcb083811b07a634491))

## [0.1.22](https://github.com/therandomsecurityguy/cachet/compare/v0.1.21...v0.1.22) (2026-10-21)


### Features

* **cli:** verify publication and artifact before loading (M5 / WS3.2) ([6b938ad](https://github.com/therandomsecurityguy/cachet/commit/6b938ad3c371eecfeba5da59fa12808e013d77c1))
* **cli:** verify publication/artifact before loading (supply chain M5 / WS3.2) ([9b78bad](https://github.com/therandomsecurityguy/cachet/commit/9b78badd6c5c0d1e0d45f5e824601f80761d5ce8))
* **sdk:** client-side verification helpers (M5 / WS3.1) ([7d0a08d](https://github.com/therandomsecurityguy/cachet/commit/7d0a08dbce344cc1067c9a21febd20d23bf6b709))
* **sdk:** client-side verification helpers (supply chain M5 / WS3.1) ([0b9169a](https://github.com/therandomsecurityguy/cachet/commit/0b9169a090f572d27e372103dbc5f3668e167154))

## [0.1.21](https://github.com/therandomsecurityguy/cachet/compare/v0.1.20...v0.1.21) (2026-10-20)


### Features

* **registry:** DSSE/in-toto attestation ingestion (M4 / WS2.3) ([feab315](https://github.com/therandomsecurityguy/cachet/commit/feab315ba0e19f016ced89ce3bdd787c01292efa))
* **registry:** DSSE/in-toto attestation ingestion (supply chain M4 / WS2.3) ([345f469](https://github.com/therandomsecurityguy/cachet/commit/345f46978916150ef3b89dcda1f1ea56c032c6b6))

## [0.1.20](https://github.com/therandomsecurityguy/cachet/compare/v0.1.19...v0.1.20) (2026-10-19)


### Bug Fixes

* **scripts:** qualify image refs with ECR in verify-release-signatures ([aa07790](https://github.com/therandomsecurityguy/cachet/commit/aa077908c549e23616cf9f4b540d3dd329de5a2e))

## [0.1.19](https://github.com/therandomsecurityguy/cachet/compare/v0.1.18...v0.1.19) (2026-10-19)


### Bug Fixes

* **registry:** let the publish role pull layers for SBOM scanning ([e059142](https://github.com/therandomsecurityguy/cachet/commit/e059142a5189ed08ee2fae26e3a215808b264adb))
* **registry:** publish role needs ecr:GetDownloadUrlForLayer for release SBOMs ([6253cee](https://github.com/therandomsecurityguy/cachet/commit/6253ceecb955c55559b22618664e6bc05fe89158))

## [0.1.18](https://github.com/therandomsecurityguy/cachet/compare/v0.1.17...v0.1.18) (2026-10-19)


### Features

* **ci:** signed + attested releases, npm provenance, pre-apply verification (supply chain M3) ([79ea577](https://github.com/therandomsecurityguy/cachet/commit/79ea5770eee978c908717c8a5ab5cc7b4a294cc2))

## [0.1.17](https://github.com/therandomsecurityguy/cachet/compare/v0.1.16...v0.1.17) (2026-10-19)


### Features

* **mcp:** opt-in read gates for revoked/unverified publications (supply chain M2 / WS1.5) ([577cb60](https://github.com/therandomsecurityguy/cachet/commit/577cb60068dbca8b6cb1a29ef9e513073406df56))


### Bug Fixes

* **mcp:** require the read gate and deny revoked reads by default ([46c3944](https://github.com/therandomsecurityguy/cachet/commit/46c39446c3752cbccae85513e480e0dd2a2e4159))

## [0.1.16](https://github.com/therandomsecurityguy/cachet/compare/v0.1.15...v0.1.16) (2026-10-19)


### Features

* **mcp:** add read-only registry.verify_publication tool (M2 / WS1.4) ([96bf31c](https://github.com/therandomsecurityguy/cachet/commit/96bf31c3d03185821e8ed5fd98bb7eb8c3f38bb4))
* **mcp:** registry.verify_publication read-only tool (supply chain M2 / WS1.4) ([aa6ded3](https://github.com/therandomsecurityguy/cachet/commit/aa6ded315a12ca460a3c2984c7e05abd9e0d461b))

## [0.1.15](https://github.com/therandomsecurityguy/cachet/compare/v0.1.14...v0.1.15) (2026-10-19)


### Features

* **api:** artifact byte transport with Content-Digest (supply chain M2 / WS1.3) ([c7c5f0a](https://github.com/therandomsecurityguy/cachet/commit/c7c5f0a118043c141c045d68ec845d0d87aa54c0))
* **api:** transport artifact bytes at /v1/artifacts/{sha256} ([5e6f6c0](https://github.com/therandomsecurityguy/cachet/commit/5e6f6c08295b24171ef42e9e28e75b6e828ada24))
* **registry:** freeze publication envelopes and verify CAS reads ([f4f2df7](https://github.com/therandomsecurityguy/cachet/commit/f4f2df7700de6e08929f75ba3e12f14c08ef6ccb))
* supply chain M1 (frozen publication envelopes, verified CAS reads) + CI hardening ([771a3f3](https://github.com/therandomsecurityguy/cachet/commit/771a3f3e2bc9b140fc3a6be1c29a386afe7872b9))


### Bug Fixes

* **sdk:** declare @eslint/js (ESLint 10 dropped it) to unbreak the SDK job ([70286f7](https://github.com/therandomsecurityguy/cachet/commit/70286f724f17738f353d1ed177fe81c2576d6f8e))
* **sdk:** declare @eslint/js so ESLint 10 can load the flat config ([6be8d7f](https://github.com/therandomsecurityguy/cachet/commit/6be8d7f889d406c6179d9b305d98fa25b28ffadb))

## [0.1.14](https://github.com/therandomsecurityguy/cachet/compare/v0.1.13...v0.1.14) (2026-10-16)


### Features

* **s3:** Enable bucket access logging (ENG-94247) ([f370626](https://github.com/therandomsecurityguy/cachet/commit/f3706265f18e9d23d1714402795a9a2663f5d014))
* **webapp:** match the khalifa dashboard look and feel ([eb4c38f](https://github.com/therandomsecurityguy/cachet/commit/eb4c38fcb9d684e7109b30378302548ff21e47b1))
* **webapp:** update dashboard UI ([88da3db](https://github.com/therandomsecurityguy/cachet/commit/88da3db9a19fe3ac372fd105197f34fc3bcb378f))


### Bug Fixes

* **s3:** Drop always-true count on access-log destination and use common tags ([db8f783](https://github.com/therandomsecurityguy/cachet/commit/db8f783e54223ccd57d7a32a3bb5dfe419b5d5f4))
* **webapp:** degrade gracefully when ontology authoring is not configured ([8129f4e](https://github.com/therandomsecurityguy/cachet/commit/8129f4eaeb879ac0dee59084ff3cc3b96343aac2))

## [0.1.13](https://github.com/therandomsecurityguy/cachet/compare/v0.1.12...v0.1.13) (2026-10-12)


### Features

* **webapp:** status column, pagination, reverse links, /login, graph filter ([64a5be7](https://github.com/therandomsecurityguy/cachet/commit/64a5be7e9205528e9ed29816b8c6a903b6e8be40))
* **webapp:** UI polish — search, breadcrumbs, compact session, richer cards ([4e71a17](https://github.com/therandomsecurityguy/cachet/commit/4e71a1729bf908b24d997165a467ed631c5c0670))

## [0.1.12](https://github.com/therandomsecurityguy/cachet/compare/v0.1.11...v0.1.12) (2026-10-11)


### Features

* **webapp:** link API docs + MCP from the home page; add demo reseed runbook ([378b293](https://github.com/therandomsecurityguy/cachet/commit/378b2937da2d132d190076ef0594022d60f07f9a))

## [0.1.11](https://github.com/therandomsecurityguy/cachet/compare/v0.1.10...v0.1.11) (2026-10-10)


### Bug Fixes

* **webapp:** Okta login behind Cloudflare Access ([8baa904](https://github.com/therandomsecurityguy/cachet/commit/8baa90462239d123e36133a203dcbe60565fad68))

## [0.1.10](https://github.com/therandomsecurityguy/cachet/compare/v0.1.9...v0.1.10) (2026-10-10)


### Features

* **webapp:** fuller design pass (dashboard, nav, badges, theme) ([13d271a](https://github.com/therandomsecurityguy/cachet/commit/13d271ad4907d2a20dcc04cdbc0406c00a1fd66b))


### Bug Fixes

* **ui:** repair registry reads (Fuseki dataset + creds) and restyle with Pico ([6bd4189](https://github.com/therandomsecurityguy/cachet/commit/6bd4189f90e25a29f585e2cc426755182365aa64))
* **webapp:** empty-graph 200, configurable Fuseki URL ([2c94a3e](https://github.com/therandomsecurityguy/cachet/commit/2c94a3e2e2668e210f84558790892c6ed67f122d))

## [0.1.9](https://github.com/therandomsecurityguy/cachet/compare/v0.1.8...v0.1.9) (2026-10-09)


### Features

* add cachet-registry agent onboarding skill ([42b2798](https://github.com/therandomsecurityguy/cachet/commit/42b2798d98636c679620fefc0511614558356831))
* add cognitive layer for agent context management ([5c1ff64](https://github.com/therandomsecurityguy/cachet/commit/5c1ff64581ec85f9f5d2b22ad46bbc9e8d4c1e31))
* add graph-native transparency governance, verification, and witness network trust ([a8e6142](https://github.com/therandomsecurityguy/cachet/commit/a8e6142798714a0ea7d2f78d3ada33ea4eece4b9))
* add OpenAPI spec, typed registry SDK, and API reference docs ([614f04e](https://github.com/therandomsecurityguy/cachet/commit/614f04e7d0601ca0b341f7440ff8381185b84a6e))
* add registry.search discovery tool and MCP onboarding docs ([fbb31e7](https://github.com/therandomsecurityguy/cachet/commit/fbb31e767eb5e562e53e546f0062e0258691dd4c))
* **api:** add transparency verification, key management, and log routes ([f9d60e9](https://github.com/therandomsecurityguy/cachet/commit/f9d60e930ac9ab4d1680d21512a8bc0274c660d3))
* **api:** self-serve API keys with scopes, expiry, rotation and revocation ([94fd55c](https://github.com/therandomsecurityguy/cachet/commit/94fd55ce46cc8d0e3b5d72fd0fb51fe6ad49bfdc))
* **auth:** add Okta group-based RBAC and confidential-client OIDC ([c8d2e4f](https://github.com/therandomsecurityguy/cachet/commit/c8d2e4f246b93c14d63ef747a405c7f606df13dd))
* **auth:** Okta group-based RBAC + confidential-client OIDC ([fbc7dea](https://github.com/therandomsecurityguy/cachet/commit/fbc7dea93fe13d9a3cd82798494ccfd44b7e05de))
* cachet-registry agent onboarding skill ([ea3dd29](https://github.com/therandomsecurityguy/cachet/commit/ea3dd293f8cf4621c4ac006ed150105e11456ba8))
* **chart:** annotate ServiceAccount for ESO SecretStore provisioning ([714c6de](https://github.com/therandomsecurityguy/cachet/commit/714c6de606e325b333b35b1cd9b4069bf3019a0d))
* **chart:** inject cachet secrets via ExternalSecret (ESO) ([091bb6b](https://github.com/therandomsecurityguy/cachet/commit/091bb6b750dcf05b039e6bc571eda3f98d328311))
* **chart:** inject secrets via ExternalSecret (ESO) on the platform ([ca52886](https://github.com/therandomsecurityguy/cachet/commit/ca528862cc5ce2a573b1d410fa245455302e842e))
* **chart:** make Cachet chart deployable — secrets, resources, HA, graceful shutdown ([470987c](https://github.com/therandomsecurityguy/cachet/commit/470987c16ec0a5c8eae0ce5a5929cf0c1a81d770))
* **chart:** make Cachet chart deployable — secrets, resources, HA, graceful shutdown ([ea45986](https://github.com/therandomsecurityguy/cachet/commit/ea45986b9ddbe7c62f6662d28643c4bf9168a7c5))
* **cli:** add transparency sample graph operator flow ([9033fbe](https://github.com/therandomsecurityguy/cachet/commit/9033fbe4f4da7b99922fab68483bedc96f46e114))
* **client:** Cloudflare Access service-token headers for SDK and CLI ([db486e0](https://github.com/therandomsecurityguy/cachet/commit/db486e0bf2759c4f4216955d9dc0d6af6651359e))
* cognitive layer for agent context management ([79ffbd6](https://github.com/therandomsecurityguy/cachet/commit/79ffbd6d500ec83176c5468d374783fe0112c7f7))
* **deploy:** migrate cachet off the platform pipeline to the tf-io-sec path ([a8fd228](https://github.com/therandomsecurityguy/cachet/commit/a8fd2284843c22d7adef688884953d7e4ac94c06))
* **infra:** add tessera aws backend and env wiring ([79f6504](https://github.com/therandomsecurityguy/cachet/commit/79f650412ea5b45c22442d858ba0b0221c2d74a5))
* **obs:** OTLP tracing, Prometheus /metrics, SLO alerts, runbooks ([97b4533](https://github.com/therandomsecurityguy/cachet/commit/97b4533e7f96d13d4eb48d887fc7acfa52c0d28d))
* **obs:** OTLP tracing, Prometheus /metrics, SLO alerts, runbooks ([4103385](https://github.com/therandomsecurityguy/cachet/commit/410338562ff07791c4f590c0a8a72c6a7af3e06f))
* onboard cachet as an app to the platform deploy pipeline ([81ce144](https://github.com/therandomsecurityguy/cachet/commit/81ce144bb3e03d900919201fd69e0533b15e0237))
* onboard cachet as an app to the platform deploy pipeline ([9e6054d](https://github.com/therandomsecurityguy/cachet/commit/9e6054d77030da1b50df9bde597c700b2b0b3bdf))
* OpenAPI spec, typed registry SDK, and API reference docs ([59bb428](https://github.com/therandomsecurityguy/cachet/commit/59bb428ca75122533e64ff9926b2041111cfe50d))
* package registry-operator CLI for distribution ([9842ae4](https://github.com/therandomsecurityguy/cachet/commit/9842ae4adf5e435119189d38a05586869398a3af))
* package registry-operator CLI for distribution ([2977149](https://github.com/therandomsecurityguy/cachet/commit/29771496c6c5404f2fe93c5752c1a932547dff4c))
* **read-surfaces:** expose governance and transparency details ([2a60bf7](https://github.com/therandomsecurityguy/cachet/commit/2a60bf780722193ae56877463b3b73b31d0426a9))
* registry.search discovery tool and MCP onboarding docs ([418ac43](https://github.com/therandomsecurityguy/cachet/commit/418ac43e4eb64321238a833a8aed75b0665f6ba5))
* **registry:** add transparency trust graph and witness network semantics ([4857fb2](https://github.com/therandomsecurityguy/cachet/commit/4857fb2ad49eac282620fe397cb3250489df357f))
* **registry:** advisory LLM validation layer and human review workflow ([2795f27](https://github.com/therandomsecurityguy/cachet/commit/2795f279122c2559c08fbc7d6c8cf231e1912d56))
* **registry:** advisory LLM validation layer and human review workflow (Phase 9, final) ([6d69dfc](https://github.com/therandomsecurityguy/cachet/commit/6d69dfc40e7cd5464ad16df7bf1974f65d9f5c62))
* **registry:** canonical RDF (RDFC-1.0) projection and dual signatures ([900f5a6](https://github.com/therandomsecurityguy/cachet/commit/900f5a6feb4d4600e5e098ddceccdcd9e2d4bfcb))
* **registry:** canonical RDF (RDFC-1.0) projection and dual signatures (Phase 7) ([31d231a](https://github.com/therandomsecurityguy/cachet/commit/31d231ac111e18861d58a2bfd2b10f19802de066))
* **registry:** certification state machine and agent lifecycle parity ([b96550a](https://github.com/therandomsecurityguy/cachet/commit/b96550a88cd17a693b0853ea7dc642fe43dad429))
* **registry:** certification state machine and agent lifecycle parity (Phase 2) ([7790b77](https://github.com/therandomsecurityguy/cachet/commit/7790b772f7f630a245a5b72dff3b93cf18c20399))
* **registry:** dual ontology system with claim validation and certification binding ([87a77cd](https://github.com/therandomsecurityguy/cachet/commit/87a77cd580ec081e600df1199983e9c24858d36a))
* **registry:** dual ontology system with claim validation and certification binding (Phase 4) ([629a7d7](https://github.com/therandomsecurityguy/cachet/commit/629a7d7edd56453afd5cc488c53b7273615b8e67))
* **registry:** internal governance event Merkle log with proof generation and replay ([46298d1](https://github.com/therandomsecurityguy/cachet/commit/46298d1ea7d50f54ba750488dfb127c0a2768e8e))
* **registry:** internal governance event Merkle log with proof generation and replay (Phase 6) ([d830bb2](https://github.com/therandomsecurityguy/cachet/commit/d830bb2a0a3f8a9423be92605e9f9e1ec6c860e6))
* **registry:** PROV-O provenance tracking, audit replay, and CI workflows ([363070e](https://github.com/therandomsecurityguy/cachet/commit/363070ed187989b52077871920804de08a544da4))
* **registry:** PROV-O provenance tracking, audit replay, and CI workflows (Phase 5) ([1c35979](https://github.com/therandomsecurityguy/cachet/commit/1c35979f7469b5916dd5394a84bbcdb23ecf6faa))
* **registry:** RFC 8785 JCS canonicalization and envelope reference completion ([5949c0e](https://github.com/therandomsecurityguy/cachet/commit/5949c0eff12069b732bfbbaa690e68794f62fde6))
* **registry:** RFC 8785 JCS canonicalization and envelope reference completion (Phase 1) ([538932c](https://github.com/therandomsecurityguy/cachet/commit/538932cf4c3f5758f98a4241467eb768d15c9d08))
* **registry:** semantic compiler ingestion and de facto vocabulary workflow ([8073d4b](https://github.com/therandomsecurityguy/cachet/commit/8073d4b92f51c77d5f4b52e5ae87601e9f795a8b))
* **registry:** semantic compiler ingestion and de facto vocabulary workflow (Phase 8) ([2bf4b7f](https://github.com/therandomsecurityguy/cachet/commit/2bf4b7f731360cbe73b54346f21f444b6a7e419f))
* **registry:** SHACL-like policy validation and graph-shape hardening ([4f8c9a1](https://github.com/therandomsecurityguy/cachet/commit/4f8c9a1c492f95a527c1d13f0852e888bd78d270))
* **registry:** SHACL-like policy validation and graph-shape hardening (Phase 3) ([4565933](https://github.com/therandomsecurityguy/cachet/commit/45659332e392e0dbe2c4201af0de47c94a590f66))
* **release:** support re-publishing an existing tag ([a6a7b6d](https://github.com/therandomsecurityguy/cachet/commit/a6a7b6d34a4bf2c4a66143d3806212aa0e0cd3c2))
* **security:** Phase 3 — Redis rate limiting, CORS allowlist, prod auth gate, CI scanning + e2e ([584c106](https://github.com/therandomsecurityguy/cachet/commit/584c1068281949bf5a53f3aed3d6f6f31384a738))
* **security:** Redis rate limiting, CORS allowlist, prod auth gate, CI scanning + e2e ([6db9f07](https://github.com/therandomsecurityguy/cachet/commit/6db9f07f1231645b5694389ccefbf9a3fe5ff71d))
* **security:** wire API_KEY_PEPPER and validate peppered keys in MCP ([e2dcce2](https://github.com/therandomsecurityguy/cachet/commit/e2dcce2b29aad84f740fcf89295703d3699c900d))
* **tessera:** add sidecar and runtime companions ([27dc714](https://github.com/therandomsecurityguy/cachet/commit/27dc714780a15cd17de2db749379f67b4c437340))
* **transparency:** add registry trust surfaces and append-intent metadata ([d0f7cb1](https://github.com/therandomsecurityguy/cachet/commit/d0f7cb1595fbcec8bbe2368ace51c4c0fce06abc))


### Bug Fixes

* add missing cognitive dep to registry.search dispatch test ([ec327d1](https://github.com/therandomsecurityguy/cachet/commit/ec327d13964fdf5752a251bae4a7c574578f5893))
* add missing cognitive dep to registry.search dispatch test ([7501347](https://github.com/therandomsecurityguy/cachet/commit/7501347b7ce1832cd278172adccc5f825ebec49e))
* address broly scan findings ([44816d9](https://github.com/therandomsecurityguy/cachet/commit/44816d9c72812e93e2c628919ca4cc02971670de))
* address Broly scan findings on the app-onboarding PR ([95be20c](https://github.com/therandomsecurityguy/cachet/commit/95be20c45505319709bbe4d2edd91b2afd057464))
* **chart:** give fuseki its own resources and JVM heap ([4c24207](https://github.com/therandomsecurityguy/cachet/commit/4c24207d872cf3cd3325d3fda43b05274760d399))
* **chart:** make fuseki volume writable and default sidecar S3 env ([c883187](https://github.com/therandomsecurityguy/cachet/commit/c883187cdf100286787b022f5cb699426915979c))
* **chart:** run fuseki as root so it can initialize the PVC ([5d02e15](https://github.com/therandomsecurityguy/cachet/commit/5d02e15cadb0171872f45b23b8b9e834db59d970))
* **ci:** bump codeql-action to v4, grant grype job actions: read ([eca1f77](https://github.com/therandomsecurityguy/cachet/commit/eca1f7734d0486f090fd1bdf028dc7cdf86e7e9c))
* **ci:** call OCI-publish reusable workflow from internal github-actions repo ([839ba08](https://github.com/therandomsecurityguy/cachet/commit/839ba08725bd18f565a5fb8f68da4ba9726aa7c1))
* **ci:** call OCI-publish reusable workflow from internal github-actions repo ([62e93db](https://github.com/therandomsecurityguy/cachet/commit/62e93dbc737816b7eccfb7ac077b85cdaa99bbec))
* **ci:** pin OCI-publish reusable workflow to full commit SHA ([6957993](https://github.com/therandomsecurityguy/cachet/commit/69579937cf4e611659b6596eeff9a5cea14c4dcd))
* **ci:** quote create-github-app-token permissions input as JSON ([d9b4f0c](https://github.com/therandomsecurityguy/cachet/commit/d9b4f0c12428e00dc123530f0eb9840a7cf713a4))
* correct registry-sdk job indentation in test.yml ([5c18ed1](https://github.com/therandomsecurityguy/cachet/commit/5c18ed115f53f554bef01d5628c964779dbf714e))
* **deps:** bump OTel packages to pull @opentelemetry/core &gt;= 2.8.0 ([8be2e56](https://github.com/therandomsecurityguy/cachet/commit/8be2e5629ef1ac9056e30519078ab51362cfd7a9))
* **eks:** read values files into helm values ([d9c2ff0](https://github.com/therandomsecurityguy/cachet/commit/d9c2ff0366954a1fb42806d1bc1c9843d0134b66))
* **images:** install registry deps when building api and mcp ([d842583](https://github.com/therandomsecurityguy/cachet/commit/d842583034c06731f1a24d4582d7f1e15b4f01c1))
* install cross-package deps in registry-cli CI job ([0af3aab](https://github.com/therandomsecurityguy/cachet/commit/0af3aabdc3b17749d5e76c94caa6f4086e4c59ef))
* **mcp:** propagate review_evidence role to MCP contract types ([c1b8a44](https://github.com/therandomsecurityguy/cachet/commit/c1b8a44c1049eb12c709c1c0c3a43e9f0a6c1adc))
* **registry:** default chart ECR repo to charts/cachet ([1ef9c27](https://github.com/therandomsecurityguy/cachet/commit/1ef9c27d363b134ec3829f5e56486c6c5309800f))
* **registry:** RE2 pattern execution and vulnerable dependency updates ([53b6316](https://github.com/therandomsecurityguy/cachet/commit/53b63168f57fba7451c87e3ec7b2f918963cf5fc))
* **registry:** reject N-Quads injection via unsanitized IRIs in RDF projection ([ebec56b](https://github.com/therandomsecurityguy/cachet/commit/ebec56bd6f046ae05cbbf58b4cf82e6b343ed40b))
* **registry:** reject ReDoS-prone patterns in policy shape registration ([8a55da9](https://github.com/therandomsecurityguy/cachet/commit/8a55da9c421fcac3ab300cf2808cf5498a47e77b))
* **registry:** SSRF and prototype pollution hardening in HTTP LLM validator ([ff1cffb](https://github.com/therandomsecurityguy/cachet/commit/ff1cffb0eab1500befb1325512f77a14ccc7c94e))
* **release:** check the real chart ECR repo for immutability ([ab35d25](https://github.com/therandomsecurityguy/cachet/commit/ab35d2580581e3895c2cd67589562afe63d02afa))
* **release:** gate publish directly instead of via a resolve job ([86cfa8f](https://github.com/therandomsecurityguy/cachet/commit/86cfa8fde88278bc2f1e6788defc50303f2ad54c))
* **release:** keep the chart version in sync with releases ([595c91d](https://github.com/therandomsecurityguy/cachet/commit/595c91d59f096181ff59e27c1bff52bfbe62cd87))
* **release:** rename resolve step id to avoid output-propagation collision ([8321a6c](https://github.com/therandomsecurityguy/cachet/commit/8321a6c13bb9fdc0cb9ef876bb7bde1884ec42d2))
* **security:** bound in-memory rate limiter, resilient Redis fallback ([67a2265](https://github.com/therandomsecurityguy/cachet/commit/67a22654caf491d31be4f8ef3abc6801e7ab0d9c))
* **security:** correct OIDC publish gating and Postgres default ([739ec71](https://github.com/therandomsecurityguy/cachet/commit/739ec7144b24df752e662cfe1ccdcc9bef7f0228))
* **security:** inline the ECR KMS key policy (Broly high finding) ([f6bd19d](https://github.com/therandomsecurityguy/cachet/commit/f6bd19ded19698e3575e9df6ab6aae9c3ebff80a))
* **security:** key the MCP API-key hash unconditionally (HMAC-SHA256) ([51bd2da](https://github.com/therandomsecurityguy/cachet/commit/51bd2da66c2d60f851244f9615fcae4cbae2e83f))
* **security:** keyed API-key hashing and fail-closed admin check ([2ff2332](https://github.com/therandomsecurityguy/cachet/commit/2ff23328c5d76ec7551ab1cace77fb5f3eb9b890))
* **security:** resolve Broly IaC findings and pin setup-terraform ([8312c5c](https://github.com/therandomsecurityguy/cachet/commit/8312c5cc0a96b7d20b01ade670ee8d02480c65ae))
* **security:** use scrypt for API-key hashing ([161ce17](https://github.com/therandomsecurityguy/cachet/commit/161ce173d0c0eb1211eabfe776e0279692bdb715))
* **security:** use scrypt for MCP API-key hashing ([613dfe7](https://github.com/therandomsecurityguy/cachet/commit/613dfe78b613aede1f7a5c3d6872984ad0e97a26))

## [0.1.8](https://github.com/therandomsecurityguy/cachet/compare/v0.1.7...v0.1.8) (2026-10-09)


### Features

* **api:** self-serve API keys with scopes, expiry, rotation and revocation ([94fd55c](https://github.com/therandomsecurityguy/cachet/commit/94fd55ce46cc8d0e3b5d72fd0fb51fe6ad49bfdc))
* **security:** wire API_KEY_PEPPER and validate peppered keys in MCP ([e2dcce2](https://github.com/therandomsecurityguy/cachet/commit/e2dcce2b29aad84f740fcf89295703d3699c900d))


### Bug Fixes

* **security:** use scrypt for API-key hashing ([161ce17](https://github.com/therandomsecurityguy/cachet/commit/161ce173d0c0eb1211eabfe776e0279692bdb715))
* **security:** keyed API-key hashing and fail-closed admin check ([2ff2332](https://github.com/therandomsecurityguy/cachet/commit/2ff23328c5d76ec7551ab1cace77fb5f3eb9b890))
* **security:** use scrypt for MCP API-key hashing ([613dfe7](https://github.com/therandomsecurityguy/cachet/commit/613dfe7))

## [0.1.7](https://github.com/therandomsecurityguy/cachet/compare/v0.1.6...v0.1.7) (2026-10-09)


### Features

* **client:** Cloudflare Access service-token headers for SDK and CLI ([db486e0](https://github.com/therandomsecurityguy/cachet/commit/db486e0bf2759c4f4216955d9dc0d6af6651359e))

## [0.1.6](https://github.com/therandomsecurityguy/cachet/compare/v0.1.5...v0.1.6) (2026-10-09)


### Bug Fixes

* **chart:** give fuseki its own resources and JVM heap ([4c24207](https://github.com/therandomsecurityguy/cachet/commit/4c24207d872cf3cd3325d3fda43b05274760d399))

## [0.1.5](https://github.com/therandomsecurityguy/cachet/compare/v0.1.4...v0.1.5) (2026-10-08)


### Bug Fixes

* **chart:** make fuseki volume writable and default sidecar S3 env ([c883187](https://github.com/therandomsecurityguy/cachet/commit/c883187cdf100286787b022f5cb699426915979c))
* **chart:** run fuseki as root so it can initialize the PVC ([5d02e15](https://github.com/therandomsecurityguy/cachet/commit/5d02e15cadb0171872f45b23b8b9e834db59d970))
* **eks:** read values files into helm values ([d9c2ff0](https://github.com/therandomsecurityguy/cachet/commit/d9c2ff0366954a1fb42806d1bc1c9843d0134b66))

## [0.1.4](https://github.com/therandomsecurityguy/cachet/compare/v0.1.3...v0.1.4) (2026-10-08)


### Bug Fixes

* **registry:** default chart ECR repo to charts/cachet ([1ef9c27](https://github.com/therandomsecurityguy/cachet/commit/1ef9c27d363b134ec3829f5e56486c6c5309800f))

## [0.1.3](https://github.com/therandomsecurityguy/cachet/compare/v0.1.2...v0.1.3) (2026-10-08)


### Bug Fixes

* **images:** install registry deps when building api and mcp ([d842583](https://github.com/therandomsecurityguy/cachet/commit/d842583034c06731f1a24d4582d7f1e15b4f01c1))

## [0.1.2](https://github.com/therandomsecurityguy/cachet/compare/v0.1.1...v0.1.2) (2026-10-07)


### Features

* **release:** support re-publishing an existing tag ([a6a7b6d](https://github.com/therandomsecurityguy/cachet/commit/a6a7b6d34a4bf2c4a66143d3806212aa0e0cd3c2))


### Bug Fixes

* **release:** keep the chart version in sync with releases ([595c91d](https://github.com/therandomsecurityguy/cachet/commit/595c91d59f096181ff59e27c1bff52bfbe62cd87))

## [0.1.1](https://github.com/therandomsecurityguy/cachet/compare/v0.1.0...v0.1.1) (2026-10-07)


### Features

* add cachet-registry agent onboarding skill ([42b2798](https://github.com/therandomsecurityguy/cachet/commit/42b2798d98636c679620fefc0511614558356831))
* add cognitive layer for agent context management ([5c1ff64](https://github.com/therandomsecurityguy/cachet/commit/5c1ff64581ec85f9f5d2b22ad46bbc9e8d4c1e31))
* add graph-native transparency governance, verification, and witness network trust ([a8e6142](https://github.com/therandomsecurityguy/cachet/commit/a8e6142798714a0ea7d2f78d3ada33ea4eece4b9))
* add OpenAPI spec, typed registry SDK, and API reference docs ([614f04e](https://github.com/therandomsecurityguy/cachet/commit/614f04e7d0601ca0b341f7440ff8381185b84a6e))
* add registry.search discovery tool and MCP onboarding docs ([fbb31e7](https://github.com/therandomsecurityguy/cachet/commit/fbb31e767eb5e562e53e546f0062e0258691dd4c))
* **api:** add transparency verification, key management, and log routes ([f9d60e9](https://github.com/therandomsecurityguy/cachet/commit/f9d60e930ac9ab4d1680d21512a8bc0274c660d3))
* **auth:** add Okta group-based RBAC and confidential-client OIDC ([c8d2e4f](https://github.com/therandomsecurityguy/cachet/commit/c8d2e4f246b93c14d63ef747a405c7f606df13dd))
* **auth:** Okta group-based RBAC + confidential-client OIDC ([fbc7dea](https://github.com/therandomsecurityguy/cachet/commit/fbc7dea93fe13d9a3cd82798494ccfd44b7e05de))
* cachet-registry agent onboarding skill ([ea3dd29](https://github.com/therandomsecurityguy/cachet/commit/ea3dd293f8cf4621c4ac006ed150105e11456ba8))
* **chart:** annotate ServiceAccount for ESO SecretStore provisioning ([714c6de](https://github.com/therandomsecurityguy/cachet/commit/714c6de606e325b333b35b1cd9b4069bf3019a0d))
* **chart:** inject cachet secrets via ExternalSecret (ESO) ([091bb6b](https://github.com/therandomsecurityguy/cachet/commit/091bb6b750dcf05b039e6bc571eda3f98d328311))
* **chart:** inject secrets via ExternalSecret (ESO) on the platform ([ca52886](https://github.com/therandomsecurityguy/cachet/commit/ca528862cc5ce2a573b1d410fa245455302e842e))
* **chart:** make Cachet chart deployable — secrets, resources, HA, graceful shutdown ([470987c](https://github.com/therandomsecurityguy/cachet/commit/470987c16ec0a5c8eae0ce5a5929cf0c1a81d770))
* **chart:** make Cachet chart deployable — secrets, resources, HA, graceful shutdown ([ea45986](https://github.com/therandomsecurityguy/cachet/commit/ea45986b9ddbe7c62f6662d28643c4bf9168a7c5))
* **cli:** add transparency sample graph operator flow ([9033fbe](https://github.com/therandomsecurityguy/cachet/commit/9033fbe4f4da7b99922fab68483bedc96f46e114))
* cognitive layer for agent context management ([79ffbd6](https://github.com/therandomsecurityguy/cachet/commit/79ffbd6d500ec83176c5468d374783fe0112c7f7))
* **deploy:** migrate cachet off the platform pipeline to the tf-io-sec path ([a8fd228](https://github.com/therandomsecurityguy/cachet/commit/a8fd2284843c22d7adef688884953d7e4ac94c06))
* **infra:** add tessera aws backend and env wiring ([79f6504](https://github.com/therandomsecurityguy/cachet/commit/79f650412ea5b45c22442d858ba0b0221c2d74a5))
* **obs:** OTLP tracing, Prometheus /metrics, SLO alerts, runbooks ([97b4533](https://github.com/therandomsecurityguy/cachet/commit/97b4533e7f96d13d4eb48d887fc7acfa52c0d28d))
* **obs:** OTLP tracing, Prometheus /metrics, SLO alerts, runbooks ([4103385](https://github.com/therandomsecurityguy/cachet/commit/410338562ff07791c4f590c0a8a72c6a7af3e06f))
* onboard cachet as an app to the platform deploy pipeline ([81ce144](https://github.com/therandomsecurityguy/cachet/commit/81ce144bb3e03d900919201fd69e0533b15e0237))
* onboard cachet as an app to the platform deploy pipeline ([9e6054d](https://github.com/therandomsecurityguy/cachet/commit/9e6054d77030da1b50df9bde597c700b2b0b3bdf))
* OpenAPI spec, typed registry SDK, and API reference docs ([59bb428](https://github.com/therandomsecurityguy/cachet/commit/59bb428ca75122533e64ff9926b2041111cfe50d))
* package registry-operator CLI for distribution ([9842ae4](https://github.com/therandomsecurityguy/cachet/commit/9842ae4adf5e435119189d38a05586869398a3af))
* package registry-operator CLI for distribution ([2977149](https://github.com/therandomsecurityguy/cachet/commit/29771496c6c5404f2fe93c5752c1a932547dff4c))
* **read-surfaces:** expose governance and transparency details ([2a60bf7](https://github.com/therandomsecurityguy/cachet/commit/2a60bf780722193ae56877463b3b73b31d0426a9))
* registry.search discovery tool and MCP onboarding docs ([418ac43](https://github.com/therandomsecurityguy/cachet/commit/418ac43e4eb64321238a833a8aed75b0665f6ba5))
* **registry:** add transparency trust graph and witness network semantics ([4857fb2](https://github.com/therandomsecurityguy/cachet/commit/4857fb2ad49eac282620fe397cb3250489df357f))
* **registry:** advisory LLM validation layer and human review workflow ([2795f27](https://github.com/therandomsecurityguy/cachet/commit/2795f279122c2559c08fbc7d6c8cf231e1912d56))
* **registry:** advisory LLM validation layer and human review workflow (Phase 9, final) ([6d69dfc](https://github.com/therandomsecurityguy/cachet/commit/6d69dfc40e7cd5464ad16df7bf1974f65d9f5c62))
* **registry:** canonical RDF (RDFC-1.0) projection and dual signatures ([900f5a6](https://github.com/therandomsecurityguy/cachet/commit/900f5a6feb4d4600e5e098ddceccdcd9e2d4bfcb))
* **registry:** canonical RDF (RDFC-1.0) projection and dual signatures (Phase 7) ([31d231a](https://github.com/therandomsecurityguy/cachet/commit/31d231ac111e18861d58a2bfd2b10f19802de066))
* **registry:** certification state machine and agent lifecycle parity ([b96550a](https://github.com/therandomsecurityguy/cachet/commit/b96550a88cd17a693b0853ea7dc642fe43dad429))
* **registry:** certification state machine and agent lifecycle parity (Phase 2) ([7790b77](https://github.com/therandomsecurityguy/cachet/commit/7790b772f7f630a245a5b72dff3b93cf18c20399))
* **registry:** dual ontology system with claim validation and certification binding ([87a77cd](https://github.com/therandomsecurityguy/cachet/commit/87a77cd580ec081e600df1199983e9c24858d36a))
* **registry:** dual ontology system with claim validation and certification binding (Phase 4) ([629a7d7](https://github.com/therandomsecurityguy/cachet/commit/629a7d7edd56453afd5cc488c53b7273615b8e67))
* **registry:** internal governance event Merkle log with proof generation and replay ([46298d1](https://github.com/therandomsecurityguy/cachet/commit/46298d1ea7d50f54ba750488dfb127c0a2768e8e))
* **registry:** internal governance event Merkle log with proof generation and replay (Phase 6) ([d830bb2](https://github.com/therandomsecurityguy/cachet/commit/d830bb2a0a3f8a9423be92605e9f9e1ec6c860e6))
* **registry:** PROV-O provenance tracking, audit replay, and CI workflows ([363070e](https://github.com/therandomsecurityguy/cachet/commit/363070ed187989b52077871920804de08a544da4))
* **registry:** PROV-O provenance tracking, audit replay, and CI workflows (Phase 5) ([1c35979](https://github.com/therandomsecurityguy/cachet/commit/1c35979f7469b5916dd5394a84bbcdb23ecf6faa))
* **registry:** RFC 8785 JCS canonicalization and envelope reference completion ([5949c0e](https://github.com/therandomsecurityguy/cachet/commit/5949c0eff12069b732bfbbaa690e68794f62fde6))
* **registry:** RFC 8785 JCS canonicalization and envelope reference completion (Phase 1) ([538932c](https://github.com/therandomsecurityguy/cachet/commit/538932cf4c3f5758f98a4241467eb768d15c9d08))
* **registry:** semantic compiler ingestion and de facto vocabulary workflow ([8073d4b](https://github.com/therandomsecurityguy/cachet/commit/8073d4b92f51c77d5f4b52e5ae87601e9f795a8b))
* **registry:** semantic compiler ingestion and de facto vocabulary workflow (Phase 8) ([2bf4b7f](https://github.com/therandomsecurityguy/cachet/commit/2bf4b7f731360cbe73b54346f21f444b6a7e419f))
* **registry:** SHACL-like policy validation and graph-shape hardening ([4f8c9a1](https://github.com/therandomsecurityguy/cachet/commit/4f8c9a1c492f95a527c1d13f0852e888bd78d270))
* **registry:** SHACL-like policy validation and graph-shape hardening (Phase 3) ([4565933](https://github.com/therandomsecurityguy/cachet/commit/45659332e392e0dbe2c4201af0de47c94a590f66))
* **security:** Phase 3 — Redis rate limiting, CORS allowlist, prod auth gate, CI scanning + e2e ([584c106](https://github.com/therandomsecurityguy/cachet/commit/584c1068281949bf5a53f3aed3d6f6f31384a738))
* **security:** Redis rate limiting, CORS allowlist, prod auth gate, CI scanning + e2e ([6db9f07](https://github.com/therandomsecurityguy/cachet/commit/6db9f07f1231645b5694389ccefbf9a3fe5ff71d))
* **tessera:** add sidecar and runtime companions ([27dc714](https://github.com/therandomsecurityguy/cachet/commit/27dc714780a15cd17de2db749379f67b4c437340))
* **transparency:** add registry trust surfaces and append-intent metadata ([d0f7cb1](https://github.com/therandomsecurityguy/cachet/commit/d0f7cb1595fbcec8bbe2368ace51c4c0fce06abc))


### Bug Fixes

* add missing cognitive dep to registry.search dispatch test ([ec327d1](https://github.com/therandomsecurityguy/cachet/commit/ec327d13964fdf5752a251bae4a7c574578f5893))
* add missing cognitive dep to registry.search dispatch test ([7501347](https://github.com/therandomsecurityguy/cachet/commit/7501347b7ce1832cd278172adccc5f825ebec49e))
* address broly scan findings ([44816d9](https://github.com/therandomsecurityguy/cachet/commit/44816d9c72812e93e2c628919ca4cc02971670de))
* address Broly scan findings on the app-onboarding PR ([95be20c](https://github.com/therandomsecurityguy/cachet/commit/95be20c45505319709bbe4d2edd91b2afd057464))
* **ci:** bump codeql-action to v4, grant grype job actions: read ([eca1f77](https://github.com/therandomsecurityguy/cachet/commit/eca1f7734d0486f090fd1bdf028dc7cdf86e7e9c))
* **ci:** call OCI-publish reusable workflow from internal github-actions repo ([839ba08](https://github.com/therandomsecurityguy/cachet/commit/839ba08725bd18f565a5fb8f68da4ba9726aa7c1))
* **ci:** call OCI-publish reusable workflow from internal github-actions repo ([62e93db](https://github.com/therandomsecurityguy/cachet/commit/62e93dbc737816b7eccfb7ac077b85cdaa99bbec))
* **ci:** pin OCI-publish reusable workflow to full commit SHA ([6957993](https://github.com/therandomsecurityguy/cachet/commit/69579937cf4e611659b6596eeff9a5cea14c4dcd))
* **ci:** quote create-github-app-token permissions input as JSON ([d9b4f0c](https://github.com/therandomsecurityguy/cachet/commit/d9b4f0c12428e00dc123530f0eb9840a7cf713a4))
* correct registry-sdk job indentation in test.yml ([5c18ed1](https://github.com/therandomsecurityguy/cachet/commit/5c18ed115f53f554bef01d5628c964779dbf714e))
* **deps:** bump OTel packages to pull @opentelemetry/core &gt;= 2.8.0 ([8be2e56](https://github.com/therandomsecurityguy/cachet/commit/8be2e5629ef1ac9056e30519078ab51362cfd7a9))
* install cross-package deps in registry-cli CI job ([0af3aab](https://github.com/therandomsecurityguy/cachet/commit/0af3aabdc3b17749d5e76c94caa6f4086e4c59ef))
* **mcp:** propagate review_evidence role to MCP contract types ([c1b8a44](https://github.com/therandomsecurityguy/cachet/commit/c1b8a44c1049eb12c709c1c0c3a43e9f0a6c1adc))
* **registry:** RE2 pattern execution and vulnerable dependency updates ([53b6316](https://github.com/therandomsecurityguy/cachet/commit/53b63168f57fba7451c87e3ec7b2f918963cf5fc))
* **registry:** reject N-Quads injection via unsanitized IRIs in RDF projection ([ebec56b](https://github.com/therandomsecurityguy/cachet/commit/ebec56bd6f046ae05cbbf58b4cf82e6b343ed40b))
* **registry:** reject ReDoS-prone patterns in policy shape registration ([8a55da9](https://github.com/therandomsecurityguy/cachet/commit/8a55da9c421fcac3ab300cf2808cf5498a47e77b))
* **registry:** SSRF and prototype pollution hardening in HTTP LLM validator ([ff1cffb](https://github.com/therandomsecurityguy/cachet/commit/ff1cffb0eab1500befb1325512f77a14ccc7c94e))
* **security:** bound in-memory rate limiter, resilient Redis fallback ([67a2265](https://github.com/therandomsecurityguy/cachet/commit/67a22654caf491d31be4f8ef3abc6801e7ab0d9c))
* **security:** inline the ECR KMS key policy (Broly high finding) ([f6bd19d](https://github.com/therandomsecurityguy/cachet/commit/f6bd19ded19698e3575e9df6ab6aae9c3ebff80a))
* **security:** resolve Broly IaC findings and pin setup-terraform ([8312c5c](https://github.com/therandomsecurityguy/cachet/commit/8312c5cc0a96b7d20b01ade670ee8d02480c65ae))
