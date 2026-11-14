# `@signet-registry/sdk`

Typed, **read-first** client SDK for the Signet registry API.

It is generated from the OpenAPI 3.1 spec served by `service/api` at
`GET /v1/openapi.json`, so the types never drift from the API contract.

## Install

```bash
npm install @signet-registry/sdk
```

## Quick start

```ts
import { RegistryClient } from '@signet-registry/sdk';

const client = new RegistryClient({
  baseUrl: 'http://localhost:3100',
  apiToken: '<write-or-read-token>',
});
```

For the deployed tunnels (behind Cloudflare Access), pass the service-token
headers as well:

```ts
const client = new RegistryClient({
  baseUrl: 'https://signet-api.example.com',
  apiToken: process.env.SIGNET_KEY,
  headers: {
    'CF-Access-Client-Id': process.env.SIGNET_CF_ACCESS_CLIENT_ID!,
    'CF-Access-Client-Secret': process.env.SIGNET_CF_ACCESS_CLIENT_SECRET!,
  },
});
```

```ts
// Discover
const skills = await client.listSkills();
const agents = await client.listAgents();

// Inspect
const skill = await client.getSkill('skill:example');
const active = await client.getActiveSkillVersion('skill:example');

// Trust
const verification = await client.getSkillVerification('skill:example', 1);
const provenance = await client.getSkillProvenance('skill:example', 1);
const log = await client.getTransparencyLog('registry-governance-dev');
```

## Read methods

### Skills
- `listSkills({ limit?, offset? })`
- `getSkill(skillKey)`
- `listSkillVersions(skillKey)`
- `getSkillVersion(skillKey, version)`
- `getActiveSkillVersion(skillKey)`
- `getSkillPublicationEnvelope(skillKey, version)`
- `getSkillVerification(skillKey, version)`
- `getSkillProvenance(skillKey, version)`

### Agents
- `listAgents({ harness_name?, limit?, offset? })`
- `getAgent(agentKey)`
- `listAgentVersions(agentKey)`
- `getActiveAgentVersion(agentKey)`
- `getAgentPublicationEnvelope(agentKey, version)`
- `getAgentVerification(agentKey, version)`
- `getAgentProvenance(agentKey, version)`

### Trust / transparency
- `listPublicKeys()`
- `getPublicKey(keyRef)`
- `listTransparencyLogs()`
- `getTransparencyLog(logId)`
- `getTransparencyLogVerification(logId)`
- `getTransparencyLogTimeline(logId)`
- `getGovernanceLog()`
- `getGraphSubgraph({ root_urn, depth? })`
- `fetchArtifact({ sha256 | artifact_urn })` — bytes re-hashed locally

## Client-side verification (verify before load)

Do not trust a publication just because the API served it — reproduce the
verdict locally:

```ts
import {
  RegistryClient,
  sha256Hex,
  verifyDetachedSignature,
  verifyEnvelopeSignatures,
  verifyRfc6962InclusionProof,
  rfc6962LeafHash,
} from '@signet-registry/sdk';

const client = new RegistryClient({ baseUrl, apiToken });
const envelope = await client.getSkillPublicationEnvelope('skill:access-review', 1);

// Trusted keys are registry records whose PEM lives in CAS.
const keys = await client.listPublicKeys();
const keyRef = keys.public_keys[0].key_ref;
const key = await client.getPublicKey(keyRef);
const pemArtifact = await client.fetchArtifact({ artifact_urn: key.artifacts[0].artifact_urn });
const pem = new TextDecoder().decode(pemArtifact.bytes);

const verdict = verifyEnvelopeSignatures({
  envelope,
  resolvePublicKey: (ref) => (ref === keyRef ? pem : undefined),
});
if (!verdict.canonical_json_sha256_matches || !verdict.all_signatures_valid) {
  throw new Error('publication did not verify');
}

const artifact = await client.fetchArtifact({ sha256: envelope.artifacts[0].sha256 });
if (!artifact.digest_verified) throw new Error('artifact bytes do not match their digest');
```

- `verifyEnvelopeSignatures` recomputes the canonical JSON digest from the
  served bytes and checks every detached signature (digest match + Ed25519 /
  RSA / ECDSA verification) against your trusted keys. Canonical-RDF
  signatures additionally need `canonicalRdfBytes`.
- `verifyDetachedSignature` verifies a single `base64:`/`hex:` signature over
  arbitrary bytes.
- `fetchArtifact` re-hashes the downloaded bytes and compares them with the
  requested digest and the `Content-Digest` header.
- `rfc6962LeafHash` + `verifyRfc6962InclusionProof` verify transparency-log
  inclusion proofs given the leaf payload/hash and the checkpoint root.

## Errors

All methods throw `RegistryClientError` on non-2xx responses:

```ts
try {
  await client.getSkill('skill:missing');
} catch (err) {
  if (err instanceof RegistryClientError) {
    console.log(err.status, err.code, err.message); // 404 SKILL_NOT_FOUND ...
  }
}
```

## Regenerating types

The committed `openapi.json` is the source of truth. To regenerate the typed
client after the API contract changes:

```bash
# 1. Dump the latest spec from service/api
cd service/api
npm run dump-openapi -- ../../client/registry-sdk/openapi.json

# 2. Regenerate types
cd ../../client/registry-sdk
npm run generate:types
```

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
