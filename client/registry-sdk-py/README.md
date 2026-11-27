# Signet registry — Python SDK

Client-side verification for Signet publications, for the Python-heavy agent
ecosystem. Mirrors the TypeScript SDK (`@signet-registry/sdk`) verdict
semantics exactly, so both reproduce the same answers from the same bytes.

```python
from signet_registry import (
    RegistryClient,
    sha256_hex,
    verify_detached_signature,
    verify_envelope_signatures,
    verify_rfc6962_inclusion_proof,
)

client = RegistryClient("http://localhost:3100")

# 1. Fetch the publication envelope (any HTTP client works).
envelope = requests.get(f"{api}/v1/skills/skill:foo/versions/1/publication-envelope").json()

# 2. Reproduce the registry's verification verdict locally.
pems = {"demo://signet/demo-signing-key": open("demo-signing-key.pem").read()}
verdict = verify_envelope_signatures(
    envelope=envelope,
    resolve_public_key=lambda key_ref: pems.get(key_ref),
)
assert verdict.canonical_json_sha256_matches and verdict.all_signatures_valid

# 3. Fetch artifact bytes with a local re-hash (never trust transport).
artifact = client.fetch_artifact(sha256=envelope["artifacts"][0]["sha256"])
assert artifact.digest_verified
```

What you get:

- `verify_envelope_signatures` — canonical-JSON digest recomputation, per
  signature digest match, and crypto over the canonical bytes (ed25519,
  ed448, rsa-sha256, ecdsa p-256/p-384) against keys you trust.
- `verify_provenance_signature` — the registry's `valid` / `stale` /
  `invalid` verdict logic for provenance exports.
- `verify_rfc6962_inclusion_proof` + `rfc6962_leaf_hash` — transparency-log
  inclusion proofs (the same tree math the registry and Tessera use).
- `RegistryClient.fetch_artifact` — content-addressed byte access with a
  local re-hash and `Content-Digest` header agreement check.

No network access happens inside the verification helpers: fetch what you
need, then hand the bytes over.

## Development

Dependencies are hash-pinned (`pip-compile --generate-hashes`); regenerate
`requirements*.txt` from `requirements*.in` after changing pins. Tests:

```bash
python -m pip install --require-hashes -r requirements-dev.txt
python -m pip install -e . --no-deps
python -m pytest tests -q
```
