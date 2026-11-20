# tlog-tiles compatibility fixtures

`spec-tiles-v1.json` is a C2SP tlog-tiles fixture for a deterministic
300-entry log, generated with the real transparency-dev packages:

- `github.com/transparency-dev/tessera/api/layout` — tile/entry paths,
  partial sizes (`tile/0/000`, `tile/0/001.p/44`, `tile/1/000.p/1`, …)
- `github.com/transparency-dev/tessera/api` — `HashTile`/`EntryBundle`
  serialization

It is the **shared oracle** for two independent implementations:

- `service/tessera-runtime/tile_fixture_test.go` (Go: verifies every tile
  node with an independent RFC 6962 computation, parses tiles and entry
  bundles with the real `api` types, round-trips every path through
  `layout.TilePath`/`layout.EntriesPath`)
- the registry's TypeScript tests (`service/api/tests/unit/tlog-tiles.test.ts`:
  seeds the fixture leaves into the sidecar's fake S3 and requires the
  sidecar's `/tiles/<logId>/…` API to serve byte-identical tiles, entry
  bundles, and a coherent checkpoint)

Deterministic by construction; regenerate (only when intentionally changing
the fixture):

```bash
cd service/tessera-runtime/testdata/tiles/generate
go run . > ../spec-tiles-v1.json
```

Entry bundles carry the log's leaf DATA — for Signet's native sidecar those
are the canonical append-intent record bytes (documented in the sidecar
README; entry content formats are log-specific per the tlog-tiles spec).
