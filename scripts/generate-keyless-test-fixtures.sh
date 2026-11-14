#!/usr/bin/env bash
# Generates the keyless-signature test fixtures (Fulcio-shaped EC P-256
# certificate chains with SAN identities and OIDC issuer extensions).
# Fixtures are committed under service/api/tests/fixtures/keyless/; re-run
# this script to regenerate them (long validity, test-only keys).
set -euo pipefail

out_dir="${1:-$(cd "$(dirname "$0")/.." && pwd)/service/api/tests/fixtures/keyless}"
mkdir -p "$out_dir"
cd "$out_dir"

issuer="https://token.actions.githubusercontent.com"
issuer_hex="$(printf '%s' "$issuer" | xxd -p | tr -d '\n')"
issuer_len="$(printf '%s' "$issuer" | wc -c | tr -d ' ')"
issuer_der="0c$(printf '%02x' "$issuer_len")${issuer_hex}"

gen_ca() {
  local name="$1"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out "${name}-key.pem"
  openssl req -new -x509 -key "${name}-key.pem" -days 3650 -subj "/CN=signet test keyless ${name}" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign" \
    -out "${name}.pem"
}

gen_ca root
gen_ca other-root

# Rekor transparency-log signing key (test fixture; log id = sha256(SPKI DER)).
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out rekor-key.pem
openssl pkey -in rekor-key.pem -pubout -out rekor.pem

# Intermediate signed by the root.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out intermediate-key.pem
openssl req -new -key intermediate-key.pem -subj "/CN=signet test keyless intermediate" -out intermediate.csr
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root-key.pem -CAcreateserial -days 3650 \
  -extfile <(printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n') \
  -out intermediate.pem
rm -f intermediate.csr root.srl

gen_leaf() {
  local name="$1" ca="$2" ca_key="$3" san="$4" issuer_value="$5" issuer_oid="${6:-1.3.6.1.4.1.57264.1.1}" issuer_der_wrap="${7:-false}"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out "${name}-key.pem"
  openssl req -new -key "${name}-key.pem" -subj "/CN=" -out "${name}.csr"
  local issuer_der=""
  if [ -n "$issuer_value" ]; then
    local hex len
    hex="$(printf '%s' "$issuer_value" | xxd -p | tr -d '\n')"
    len="$(printf '%s' "$issuer_value" | wc -c | tr -d ' ')"
    if [ "$issuer_der_wrap" = "true" ]; then
      # DER UTF8String wrapper (Fulcio v2 profile, OID ...1.8)
      issuer_der="${issuer_oid}=DER:0c$(printf '%02x' "$len")${hex}"
    else
      # Raw UTF8 bytes (Fulcio v1 profile, OID ...1.1)
      issuer_der="${issuer_oid}=DER:${hex}"
    fi
  fi
  openssl x509 -req -in "${name}.csr" -CA "${ca}" -CAkey "${ca_key}" -CAcreateserial -days 365 \
    -extfile <(printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\nsubjectAltName=%s\n%s\n' "$san" "$issuer_der") \
    -out "${name}.pem"
  rm -f "${name}.csr" "${ca}.srl" "${ca%.pem}.srl" "${ca%.pem}.pem.srl"
}

workflow_san="URI:https://github.com/therandomsecurityguy/signet/.github/workflows/release.yaml@refs/tags/v0.1.28"
gen_leaf leaf intermediate.pem intermediate-key.pem "$workflow_san" "$issuer"
gen_leaf leaf-v2 intermediate.pem intermediate-key.pem "$workflow_san" "$issuer" "1.3.6.1.4.1.57264.1.8" true
gen_leaf leaf-other-root other-root.pem other-root-key.pem "$workflow_san" "$issuer"
gen_leaf leaf-other-issuer intermediate.pem intermediate-key.pem "$workflow_san" "https://accounts.google.com"
gen_leaf leaf-other-subject intermediate.pem intermediate-key.pem "URI:https://github.com/someone/else/.github/workflows/build.yaml@refs/heads/main" "$issuer"
gen_leaf leaf-email intermediate.pem intermediate-key.pem "email:release-bot@example.com" "$issuer"

echo "fixtures written to ${out_dir}"
ls -1
