## Transparency Sample Graph

This directory is the committed, teammate-facing transparency sample for `agents-registry`.

Files:
- `sample-graph.spec.json`
  - canonical sample shape for the operator CLI
  - inspectable without reading TypeScript source

What it models:
- one transparency log
- one trusted checkpoint key
- two witnesses
- two checkpoint states
- one conflicting same-size-different-root observation
- one witness-to-witness gossip event

Inspect the sample without running the stack:

```bash
cd agents-registry/client/registry-cli
npm run dev -- seed transparency-sample --spec examples/transparency/sample-graph.spec.json --dry-run
```

Seed it through the real operator path:

```bash
cd agents-registry/client/registry-cli
npm run dev -- seed transparency-sample --api-token "<api-token>" --spec examples/transparency/sample-graph.spec.json
```

Print the smaller human-facing proof report:

```bash
cd agents-registry/client/registry-cli
npm run dev -- seed transparency-sample --api-token "<api-token>" --spec examples/transparency/sample-graph.spec.json --human-proof-report
```

This gives teammates a real sample graph to play with while keeping generated graph state and CAS objects out of git.
