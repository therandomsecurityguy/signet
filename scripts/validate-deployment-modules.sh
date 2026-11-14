#!/usr/bin/env bash
# Validates the deployment modules and chart do not leak secrets and keep the
# expected security invariants. Run locally and in CI (.github/workflows/infra.yml).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

note() { printf '  %s\n' "$1"; }
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }

echo "== secret sentinels =="

# 1. Chart must not ship a namespace-level static AWS key provider.
if grep -rIn "aws static\|accessKeyID:\|secretAccessKey:" "$root/charts/signet/templates/externalsecret.yaml" >/dev/null 2>&1; then
  bad "SecretStore appears to use static AWS credentials"
else
  ok "SecretStore uses IRSA JWT auth (no static keys)"
fi

# 3. Operator-seeded secrets must not have Terraform-managed versions.
for key in okta-client-secret tessera-log-private-key; do
  if grep -rIn "\"$key\"" "$root/infra/terraform/modules/signet-data/secrets.tf" | grep -q "generated_secret_values"; then
    bad "$key is generated in Terraform (must be operator-seeded)"
  else
    ok "$key is operator-seeded (never in state)"
  fi
done

# 4. No obvious hard-coded credential literals in values files.
if grep -rEn "(secret|password|token)['\"]?\s*[:=]\s*['\"][A-Za-z0-9/+]{20,}" "$root/charts/signet/values"*.yaml >/dev/null 2>&1; then
  bad "hard-coded credential-looking literal found in chart values"
else
  ok "no hard-coded credentials in chart values"
fi

echo "== encryption invariants =="

check_grep() {
  local desc="$1" file="$2" pattern="$3"
  if grep -qE "$pattern" "$file"; then ok "$desc"; else bad "$desc"; fi
}

check_grep "RDS storage encrypted" "$root/infra/terraform/modules/signet-data/rds.tf" "storage_encrypted\s*=\s*true"
check_grep "Redis at-rest encryption" "$root/infra/terraform/modules/signet-data/redis.tf" "at_rest_encryption_enabled\s*=\s*true"
check_grep "Redis transit encryption" "$root/infra/terraform/modules/signet-data/redis.tf" "transit_encryption_enabled\s*=\s*true"
check_grep "S3 public access blocked" "$root/infra/terraform/modules/signet-data/main.tf" "restrict_public_buckets\s*=\s*true"
check_grep "S3 KMS default encryption" "$root/infra/terraform/modules/signet-data/main.tf" "aws:kms"
check_grep "KMS key rotation" "$root/infra/terraform/modules/signet-data/main.tf" "enable_key_rotation\s*=\s*true"
check_grep "ECR immutable tags" "$root/infra/terraform/modules/signet-registry/main.tf" "image_tag_mutability\s*=\s*\"IMMUTABLE\""
check_grep "ECR scan on push" "$root/infra/terraform/modules/signet-registry/main.tf" "scan_on_push\s*=\s*true"
check_grep "GitHub OIDC publish role" "$root/infra/terraform/modules/signet-registry/main.tf" "AssumeRoleWithWebIdentity"

echo "== chart rendering =="
for env in dev staging prod; do
  f="$root/charts/signet/values-$env.yaml"
  [ -f "$f" ] || { bad "missing values-$env.yaml"; continue; }
  if helm template signet "$root/charts/signet" -f "$f" \
      --set image.registry=example.com \
      --set auth.oktaIssuer=https://example.okta.com \
      --set artifacts.s3.bucket=example-bucket \
      --set serviceAccount.roleArn=arn:aws:iam::000000000000:role/example \
      >/dev/null 2>&1; then
    ok "chart renders for $env"
  else
    bad "chart failed to render for $env"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "deployment module validation failed"
  exit 1
fi

echo
echo "deployment module validation passed"
