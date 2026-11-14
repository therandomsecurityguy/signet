# Keyless (sigstore) publishing from CI

`registry-operator sign keyless` publishes a skill with a **keyless sigstore
signature**: the CI workflow's OIDC identity is exchanged at Fulcio for a
short-lived certificate, the prepared publication envelope is signed, and the
signature is attached in the same publish request — no long-lived signing
keys to manage.

## Registry configuration (one-time per environment)

The registry verifies keyless bundles against a trust policy; unconfigured
means keyless signatures are rejected:

- `KEYLESS_TRUSTED_ROOTS` — comma-separated PEM files with the trusted Fulcio
  root and intermediate(s) (for the public good instance, the sigstore TUF
  trusted root certificates; for self-hosted, your CA).
- `KEYLESS_ALLOWED_ISSUERS` — exact OIDC issuers (e.g.
  `https://token.actions.githubusercontent.com`).
- `KEYLESS_ALLOWED_SUBJECTS` — regexes matched against the certificate SAN
  (e.g. `^https://github\.com/togethercomputer/signet/`).

### Rekor anchoring (recommended)

- `KEYLESS_REKOR_PUBLIC_KEY` — PEM file with the Rekor log's public key.
- `KEYLESS_REKOR_LOG_ID` — the log id (hex; sha256 of the log key's DER
  SubjectPublicKeyInfo).

With these configured, bundles carrying a transparency-log entry are
verified: the signed entry timestamp is verified whenever present (real
Rekor v1 bundles carry both a promise and an inclusion proof), inclusion
proofs + checkpoints are verified additionally when present, and the
hashedrekord entry must match the signed payload. Certificate validity
anchors at the entry's attested integratedTime **only when a signed entry
timestamp authenticated it** — inclusion proofs do not cover integratedTime
(see `keyless.tlog.integrated_time_verified` and
`keyless.validity_evaluated_at`), so proof-only entries fall back to the
registry-witnessed attach time. **Tlog-carrying bundles fail closed when
Rekor trust is not configured**, so configure this before publishing with
`--rekor-url` or from CI that uploads to the public Rekor instance. Without
any tlog entry, validity falls back to the registry-witnessed attach time,
because Fulcio certificates live minutes; attach itself always requires the
certificate chain to be valid against the live clock, so an authenticated
anchor can never mask an already-expired certificate.

## GitHub Actions usage

```yaml
permissions:
  id-token: write   # ambient OIDC token for Fulcio
  contents: read

steps:
  - name: Publish the skill keylessly
    run: |
      npx @signet/registry-operator sign keyless \
        --skill skill:registry-search --version 2 \
        --author "$GITHUB_WORKFLOW" \
        --api-token "$REGISTRY_API_TOKEN" \
        --certify
```

- The OIDC token is picked up automatically in GitHub Actions
  (`CIContextProvider`); other environments can pass `--oidc-token`.
- `--fulcio-url` / `--rekor-url` override the public good instance defaults
  (Fulcio `https://fulcio.sigstore.dev`, Rekor `https://rekor.sigstore.dev`).
  Rekor upload is optional; the registry records the bundle either way.
- The command prints the signing identity, issuer, and the prepared
  publication URN. The publish is a single mutating request: prepare →
  sign → publish (and certify with `--certify`).

## Verification

- `registry-operator verify publication --skill <key> --version <n> --strict`
  reports the keyless verdicts (`signature_kind: keyless`,
  `keyless.verified`, identity, issuer).
- `registry.verify_publication` (MCP) exposes the same verdicts.
- The registry also re-verifies at certify, so `require_signature` policies
  accept keyless signatures whenever certification happens (not only inside
  the certificate's 10-minute window).
