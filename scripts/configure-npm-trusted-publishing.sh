#!/usr/bin/env bash
# Configures npm trusted publishing for the client packages so the publish
# workflows authenticate via GitHub OIDC (no NPM_TOKEN). The registry-side
# configuration cannot live in this repo — npm requires the package to exist
# first and a maintainer session — so this script applies the exact binding
# documented in docs/runbooks/npm-release.md.
#
# Prerequisites:
#   - npm >= 11.15.0 (the version that added `npm trust`)
#   - npm login as a maintainer with write access to the @signet scope and
#     account-level 2FA (the 2FA prompt opens in the browser)
#   - the packages already exist on npm (publish 0.1.0 first; see the runbook)
#
# Usage:
#   scripts/configure-npm-trusted-publishing.sh
#
# Re-runs are safe: a package already configured for the same workflow and
# repository is left untouched. If a different configuration exists, the
# script stops and prints the manual replace steps (list, revoke, re-run).
set -euo pipefail

repo="togethercomputer/cachet"

command -v npm >/dev/null 2>&1 || { echo "missing required command: npm" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "missing required command: node" >&2; exit 1; }

npm_version="$(npm --version)"
if ! node -e '
const [major, minor] = process.argv[1].split(".").map(Number);
process.exit(major > 11 || (major === 11 && minor >= 15) ? 0 : 1);
' "$npm_version"; then
  echo "npm $npm_version is too old for 'npm trust' (needs >= 11.15.0)." >&2
  echo "Upgrade with: npm install -g npm@^12" >&2
  exit 1
fi

packages=(
  "@signet/registry-sdk publish-registry-sdk.yml"
  "@signet/registry-operator publish-registry-cli.yml"
)

for entry in "${packages[@]}"; do
  read -r pkg workflow <<<"$entry"
  echo "== ${pkg} =="

  if ! npm view "$pkg" version >/dev/null 2>&1; then
    echo "  ${pkg} does not exist on npm yet; publish 0.1.0 first (docs/runbooks/npm-release.md)." >&2
    exit 1
  fi

  listing="$(npm trust list "$pkg" 2>/dev/null || true)"
  if grep -q "$workflow" <<<"$listing"; then
    echo "  already configured for ${workflow}; leaving it untouched."
    continue
  fi
  if [[ -n "$listing" ]]; then
    echo "  a different configuration already exists. Inspect and replace manually:" >&2
    echo "    npm trust list ${pkg}" >&2
    echo "    npm trust revoke ${pkg} --id <id>" >&2
    echo "  then re-run this script." >&2
    exit 1
  fi

  echo "  creating trusted publisher: ${repo} / ${workflow} (allow npm publish)"
  npm trust github "$pkg" --file "$workflow" --repo "$repo" --allow-publish --yes
done

echo
echo "Done. Verify on npmjs.com (package -> Settings -> Trusted publishing)."
echo "A new configuration must complete its first OIDC publish within 2 days,"
echo "or it expires and has to be recreated."
