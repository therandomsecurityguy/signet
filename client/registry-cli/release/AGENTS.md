# `client/registry-cli/release/`

Pre-built release tarballs of the `@together-ai/registry-operator` CLI are packaged
here via `npm pack`.

## Produce a release tarball

```bash
cd client/registry-cli
npm run build
npm pack --pack-destination release/
```

This writes `release/together-registry-operator-<version>.tgz`.

## Install from a tarball

```bash
npm install -g release/together-registry-operator-<version>.tgz
registry-operator --help
```

## Publish to npm

The CLI is published via the `publish-registry-cli` GitHub Actions workflow on
`registry-cli-v*` tags (see `.github/workflows/publish-registry-cli.yml`).

Release tarballs in this directory are build artifacts and should not be
committed.
