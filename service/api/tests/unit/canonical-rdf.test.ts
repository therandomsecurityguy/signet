import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  computeCanonicalRdf,
  projectPublicationGraphToNQuads,
} from '../../../registry/application/services/rdf-projection.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'RDF Writer' });
  return { app: buildApp(deps), deps, token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

describe('RDF projection and RDFC-1.0 canonicalization', () => {
  it('produces deterministic canonical bytes regardless of input ordering', async () => {
    const base = {
      publication_urn: 'urn:tg:skill-version:skill:demo@v1',
      logical_urn: 'urn:tg:skill:skill:demo',
      properties: { version: 1, artifact_sha256: 'abc', source_path: 'skills/demo.md', active: true },
      edges: [
        { predicate: 'tg:implementedBy', to_urn: 'urn:tg:artifact:sha256:abc' },
        { predicate: 'tg:usesSkill', to_urn: 'urn:tg:skill:skill:other' },
      ],
    };
    const shuffled = {
      ...base,
      properties: { active: true, source_path: 'skills/demo.md', artifact_sha256: 'abc', version: 1 },
      edges: [...base.edges].reverse(),
    };
    const first = await computeCanonicalRdf(projectPublicationGraphToNQuads(base));
    const second = await computeCanonicalRdf(projectPublicationGraphToNQuads(shuffled));
    expect(first.nquads).toBe(second.nquads);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.nquads).toContain('urn:tg:predicate:hasVersion');
    expect(first.nquads).toContain('http://www.w3.org/2001/XMLSchema#integer');
  });

  it('changes the digest when the graph changes', async () => {
    const base = {
      publication_urn: 'urn:tg:skill-version:skill:demo@v1',
      logical_urn: 'urn:tg:skill:skill:demo',
      properties: { version: 1 },
      edges: [],
    };
    const first = await computeCanonicalRdf(projectPublicationGraphToNQuads(base));
    const second = await computeCanonicalRdf(
      projectPublicationGraphToNQuads({ ...base, properties: { version: 2 } }),
    );
    expect(first.sha256).not.toBe(second.sha256);
  });

  it('rejects N-Quads injection through unsanitized IRIs', () => {
    const base = {
      publication_urn: 'urn:tg:skill-version:skill:demo@v1',
      logical_urn: 'urn:tg:skill:skill:demo',
      properties: { version: 1 },
      edges: [],
    };
    // Breakout attempt via the publication URN.
    expect(() =>
      projectPublicationGraphToNQuads({
        ...base,
        publication_urn: 'urn:tg:x@v1> <urn:tg:property:pwned> "1',
      }),
    ).toThrow(/Invalid IRI character/);
    // Breakout attempt via an edge target (e.g. a user-supplied lineage URN).
    expect(() =>
      projectPublicationGraphToNQuads({
        ...base,
        edges: [{ predicate: 'tg:dependsOnVersion', to_urn: 'urn:tg:y@v2>\n<urn:tg:z> <urn:tg:p> "x' }],
      }),
    ).toThrow(/Invalid IRI character/);
    // Space and control characters are rejected too.
    expect(() =>
      projectPublicationGraphToNQuads({ ...base, logical_urn: 'urn:tg:skill:skill:has space' }),
    ).toThrow(/Invalid IRI character/);
    expect(() =>
      projectPublicationGraphToNQuads({ ...base, logical_urn: 'urn:tg:skill:skill:has\tab' }),
    ).toThrow(/Invalid IRI character/);
  });

  it('escapes control characters in string literals', () => {
    const lines = projectPublicationGraphToNQuads({
      publication_urn: 'urn:tg:skill-version:skill:demo@v1',
      logical_urn: 'urn:tg:skill:skill:demo',
      properties: { note: 'bell\u0007 and null\u0000 bytes' },
      edges: [],
    });
    const literal = lines.find((line) => line.includes('urn:tg:property:note'));
    expect(literal).toBeDefined();
    expect(literal).not.toContain('\u0007');
    expect(literal).not.toContain('\u0000');
    expect(literal).toContain('\\u0007');
    expect(literal).toContain('\\u0000');
  });
});

describe('canonical RDF publication and dual signatures', () => {
  it('publishes canonical RDF, verifies the semantic digest, and verifies RDF-signed signatures', async () => {
    const { app, deps, token } = await buildTestApp();

    const draft = await app.request('/v1/skills/skill:rdf/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# rdf', original_path: 'skills/rdf.md' },
      }),
    });
    expect(draft.status).toBe(200);
    const publish = await app.request('/v1/skills/skill:rdf/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);

    // The envelope exposes the canonical RDF digest and artifact.
    const envelope = await app.request('/v1/skills/skill:rdf/versions/1/publication-envelope');
    expect(envelope.status).toBe(200);
    const envelopeBody = (await envelope.json()) as {
      canonical_rdf_sha256?: string;
      canonical_rdf_artifact_urn?: string;
    };
    expect(envelopeBody.canonical_rdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(envelopeBody.canonical_rdf_artifact_urn).toMatch(/^urn:tg:artifact:sha256:/);

    // The stored artifact holds the canonical N-Quads whose digest matches.
    const rdfSha = (envelopeBody.canonical_rdf_artifact_urn as string).replace('urn:tg:artifact:sha256:', '');
    const stored = await deps.registryCas.getBySha256(rdfSha);
    expect(stored).toBeDefined();
    const nquads = new TextDecoder().decode(stored?.bytes);
    expect(nquads).toContain('urn:tg:skill-version:skill:rdf@v1');
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(Buffer.from(nquads, 'utf8')).digest('hex')).toBe(
      envelopeBody.canonical_rdf_sha256,
    );

    // Baseline verification: semantic digest matches.
    const verification = await app.request('/v1/skills/skill:rdf/versions/1/verification');
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      canonical_json_sha256_matches: true,
      canonical_rdf_sha256_matches: true,
    });

    // Register a trusted key and sign the canonical RDF bytes.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const createKey = await app.request('/v1/public-keys', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        key_ref: 'kms://registry/rdf-signing-key',
        algorithm: 'ed25519',
        public_key_pem: publicKeyPem,
        owner: 'governance-team',
        trust_scope: 'skill-publication',
      }),
    });
    expect(createKey.status).toBe(201);

    const rdfSignature = `base64:${signBytes(null, Buffer.from(nquads, 'utf8'), privateKey).toString('base64')}`;
    const createSignature = await app.request('/v1/skills/skill:rdf/versions/1/signatures', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        signer: 'alice',
        key_ref: 'kms://registry/rdf-signing-key',
        algorithm: 'ed25519',
        signature: rdfSignature,
        signed_payload: 'canonical_rdf',
      }),
    });
    expect(createSignature.status).toBe(200);

    // Cross-verification: the semantic signature verifies against the
    // recomputed canonical RDF bytes of the same publication snapshot.
    const dualVerification = await app.request('/v1/skills/skill:rdf/versions/1/verification');
    expect(dualVerification.status).toBe(200);
    await expect(dualVerification.json()).resolves.toMatchObject({
      canonical_json_sha256_matches: true,
      canonical_rdf_sha256_matches: true,
      all_detached_signatures_verify_cryptographically: true,
      signature_checks: [
        {
          signed_payload: 'canonical_rdf',
          envelope_sha256_matches: true,
          trusted_public_key_resolved: true,
          cryptographic_verification_passed: true,
          verification_status: 'verified',
        },
      ],
    });
  });

  it('detects post-publication graph mutation through the semantic digest', async () => {
    const { app, deps, token } = await buildTestApp();

    const draft = await app.request('/v1/skills/skill:rdf-tamper/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# rdf tamper', original_path: 'skills/rdf-tamper.md' },
      }),
    });
    expect(draft.status).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:rdf-tamper/versions/1/publish', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    // Mutate the version graph after publication.
    const versionNode = await deps.graph.getNode('urn:tg:skill-version:skill:rdf-tamper@v1');
    expect(versionNode).toBeDefined();
    await deps.graph.upsertNode({
      urn: versionNode!.urn,
      entity_type: versionNode!.entity_type,
      properties: { ...versionNode!.properties, description: 'mutated after publish' },
    });

    const verification = await app.request('/v1/skills/skill:rdf-tamper/versions/1/verification');
    expect(verification.status).toBe(200);
    const body = (await verification.json()) as {
      canonical_json_sha256_matches: boolean;
      canonical_rdf_sha256_matches: boolean | null;
    };
    // The operational JSON digest is rebuilt from the same current state,
    // so it self-matches; the semantic RDF digest was recorded at publish
    // time and now diverges from the mutated graph.
    expect(body.canonical_json_sha256_matches).toBe(true);
    expect(body.canonical_rdf_sha256_matches).toBe(false);
  });
});
