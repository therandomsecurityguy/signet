# Client npm releases (`@signet/registry-sdk`, `@signet/registry-operator`)

Where this goes: the **public npm registry** (`https://registry.npmjs.org`),
scope `@together-ai`. Both packages are world-readable (`--access public`); they
are the adoption surfaces for the registry, so the published tarballs must be
reviewed before they leave the machine.

How publishing is authenticated: **npm trusted publishing (OIDC)** — GitHub
mints a short-lived OIDC token for the tagged workflow run and npm exchanges
it for a one-time publish credential. There is no `NPM_TOKEN`, no long-lived
credential to leak. Reference:
<https://docs.npmjs.com/trusted-publishers>.

**Provenance is currently disabled** and the workflows set
`NPM_CONFIG_PROVENANCE=false` explicitly (trusted publishing otherwise
defaults it to on). Reason: npm rejects sigstore bundles from source repos
with `internal` visibility — `E422 … Only public source repositories are
supported when publishing with provenance` — and this repository is
internal. Publishes are still OIDC-authenticated and registry-signed; they
just carry no build-provenance attestation. When this repository becomes
public, remove the env flag and the `--provenance` handling in both
workflows to re-enable it (and then `scripts/verify-npm-provenance.sh`
becomes the release gate again).

Publish workflows: `.github/workflows/publish-registry-sdk.yml` and
`.github/workflows/publish-registry-cli.yml`, triggered by
`registry-sdk-v*` / `registry-cli-v*` tags (and `workflow_dispatch`).

## One-time bootstrap (already done for 0.1.0)

Trusted publishers can only be configured for a package that **exists**, so
the first version of each package must be published by a maintainer, with the
exact artifact inspected first. Per package, from a fresh worktree at the
commit to publish:

```bash
git worktree add /tmp/signet-publish origin/main
cd /tmp/signet-publish/client/registry-sdk     # or client/registry-cli
npm config get registry    # must be https://registry.npmjs.org/
npm whoami                 # @together-ai maintainer, 2FA on
# Auth: `npm login --auth-type=web` (browser 2FA), or a granular access token
# with bypass-2FA supplied through an environment variable — never committed
# and never echoed. The bootstrap token used for 0.1.0 came from the 1Password
# "Signet" environment and was revoked right after.
npm ci --ignore-scripts    # lockfile-exact; dependency scripts do not run
npm run build              # build from the reviewed source
npm pack --ignore-scripts  # artifact == exactly what you inspected
tar -tzf together-ai-registry-sdk-0.1.0.tgz | sort
npm publish ./together-ai-registry-sdk-0.1.0.tgz --access public --ignore-scripts
npm view @signet/registry-sdk@0.1.0 dist.integrity   # must equal the local
npm pack --json --ignore-scripts                        # integrity of the tarball
git worktree remove /tmp/signet-publish
```

Then configure the trusted publishers (run once, after 0.1.0 exists):

```bash
scripts/configure-npm-trusted-publishing.sh
```

or manually on npmjs.com (package -> Settings -> Trusted publishing ->
GitHub Actions):

- Organization or user: `togethercomputer`
- Repository: `signet`
- Workflow filename: `publish-registry-sdk.yml` / `publish-registry-cli.yml`
- Environment name: *(blank — the workflows do not use a GitHub environment)*
- Allowed actions: **check "Allow npm publish"** (new configurations default
  to stage-only, which rejects plain `npm publish`)

A fresh configuration must complete its first OIDC publish **within 2 days**
or it expires. After the first OIDC publish is verified, set each package's
Publishing access to "Require two-factor authentication and disallow tokens".

## Steady-state release

```bash
# 1. Bump the package version (patch for fixes) and merge it to main.
#    client/registry-sdk/package.json / client/registry-cli/package.json

# 2. Tag the commit and push (the tag name must match the version).
git tag registry-sdk-v0.1.2
git push origin registry-sdk-v0.1.2

# 3. Watch the publish workflow, then verify the registry got the exact build:
#    rebuild + pack locally from the tagged commit and compare
#    `npm pack --json --ignore-scripts` integrity with
#    `npm view <pkg>@<version> dist.integrity`.
```

The version in `package.json` must match the tag: the workflow publishes
whatever `npm publish` finds, and npm rejects re-publishing an existing
version (re-running a `workflow_dispatch` without a bump fails safely).

## Troubleshooting

- `ENEEDAUTH` / `Unable to authenticate`: the workflow filename configured on
  npmjs.com does not match exactly (case-sensitive, includes `.yml`), or the
  workflow job lost `id-token: write`.
- `E422 … Unsupported GitHub Actions source repository visibility`: npm
  refuses provenance from non-public source repos. Keep
  `NPM_CONFIG_PROVENANCE=false` while this repository is internal; remove it
  only once the repository is public.
- After a failed publish, re-running is safe via `workflow_dispatch` on the
  commit whose `package.json` holds the unpublished version — no new tag
  needed.
- Do not create npm tokens for these packages; if one exists, revoke it
  (npmjs.com -> Access tokens) once trusted publishing is confirmed.
