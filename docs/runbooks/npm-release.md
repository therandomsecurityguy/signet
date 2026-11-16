# Client npm releases (`@signet-registry/sdk`, `@signet-registry/operator`)

Where this goes: the **public npm registry** (`https://registry.npmjs.org`),
scope `@signet`. Both packages are world-readable (`--access public`); they
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
that are not public — `E422 … Only public source repositories are
supported when publishing with provenance`. Publishes are still
OIDC-authenticated and registry-signed; they just carry no build-provenance
attestation. Once the source repository is public, remove the env flag and
the `--provenance` handling in both workflows to re-enable it (and then
`scripts/verify-npm-provenance.sh` becomes the release gate again).

Publish workflows: `.github/workflows/publish-registry-sdk.yml` and
`.github/workflows/publish-registry-cli.yml`, triggered by
`registry-sdk-v*` / `registry-cli-v*` tags (and `workflow_dispatch`).

## One-time bootstrap (first publish per package)

Trusted publishers can only be configured for a package that **exists**, so
the first version of each package must be published by a maintainer, with the
exact artifact inspected first. Per package, from a fresh worktree at the
commit to publish:

```bash
git worktree add /tmp/signet-publish origin/main
cd /tmp/signet-publish/client/registry-sdk     # or client/registry-cli
npm config get registry    # must be https://registry.npmjs.org/
npm whoami                 # @signet-registry maintainer, 2FA on
# Auth: `npm login --auth-type=web` (browser 2FA). With an auth-and-writes
# account, `npm publish` prompts for a one-time password from the
# authenticator app. Never use a committed/echoed token.
npm ci --ignore-scripts    # lockfile-exact; dependency scripts do not run
npm run build              # build from the reviewed source
npm pack --ignore-scripts  # artifact == exactly what you inspected
tar -tzf signet-registry-sdk-0.1.1.tgz | sort
npm publish ./signet-registry-sdk-0.1.1.tgz --access public --ignore-scripts
npm view @signet-registry/sdk@0.1.1 dist.integrity   # must equal the local
npm pack --json --ignore-scripts                        # integrity of the tarball
git worktree remove /tmp/signet-publish
```

The first published versions are `@signet-registry/sdk@0.1.1` and
`@signet-registry/operator@0.1.3`.

Then configure the trusted publishers (run once, after the package exists):

```bash
scripts/configure-npm-trusted-publishing.sh
```

or manually on npmjs.com (package -> Settings -> Trusted publishing ->
GitHub Actions):

- Organization or user: `therandomsecurityguy`
- Repository: `signet`
- Workflow filename: `publish-registry-sdk.yml` / `publish-registry-cli.yml`
- Environment name: *(blank — the workflows do not use a GitHub environment)*
- Allowed actions: **check "Allow npm publish"** (new configurations default
  to stage-only, which rejects plain `npm publish`)

A fresh configuration must complete its first OIDC publish **within 2 days**
or it expires. After the first OIDC publish is verified, set each package's
Publishing access to "Require two-factor authentication and disallow tokens".

## Steady-state release (automated via release-please)

Client releases are driven by **release-please** alongside the main release
(`.release-please-config.json`, packages `client/registry-sdk` and
`client/registry-cli`; one release PR per package because
`separate-pull-requests` is on, and `bootstrap-sha` keeps the first client
release PR from sweeping in pre-automation history):

1. Merge normal PRs with conventional commits (`fix(registry-sdk): …`,
   `feat(registry-cli): …`). Pre-1.0 per the shared config,
   `bump-patch-for-minor-pre-major` bumps patch for features and
   `bump-minor-pre-major` bumps minor for breaking changes.
2. release-please opens/updates `chore(main): release registry-sdk x.y.z`
   (version in `package.json` + lockfile, `CHANGELOG.md`, release notes).
   Merge it when that package should go out.
3. The merge makes release-please create the `registry-sdk-vx.y.z` tag and
   GitHub release. Those are App-authored (RELEASE_APP secrets), so the tag
   push triggers `publish-registry-sdk.yml` — OIDC publish, no manual step.
4. Verify the registry got the exact build: rebuild + pack from the tagged
   commit and compare `npm pack --json --ignore-scripts` integrity with
   `npm view <pkg>@<version> dist.integrity`.

Fallback (release-please unavailable): bump the version in
`client/registry-sdk/package.json` / `client/registry-cli/package.json`,
merge, tag the merged commit matching the version, and push the tag:

```bash
git tag registry-sdk-v0.1.2
git push origin registry-sdk-v0.1.2
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
- `E404 … PUT https://registry.npmjs.org/@signet-registry%2f<name>` during an
  OIDC publish: the package's trusted-publisher configuration is missing,
  mismatched, or expired — a fresh configuration expires if its first OIDC
  publish does not land within 2 days (and first publishes are
  maintainer-performed, see One-time bootstrap). Re-create the trusted
  publisher (workflow filename must match exactly, "Allow npm publish"
  checked), then re-run the publish workflow on the tag:
  `gh workflow run publish-registry-cli.yml --ref registry-cli-vX.Y.Z`.
- After a failed publish, re-running is safe via `workflow_dispatch` on the
  commit whose `package.json` holds the unpublished version — no new tag
  needed.
- Do not create npm tokens for these packages; if one exists, revoke it
  (npmjs.com -> Access tokens) once trusted publishing is confirmed.
