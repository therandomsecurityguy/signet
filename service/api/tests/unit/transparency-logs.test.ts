import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

// Shared oracle with the Go runtime tests (service/tessera-runtime).
const SPEC_FIXTURE = JSON.parse(
  readFileSync(new URL('../../../tessera-runtime/testdata/signed-notes/spec-note-v1.json', import.meta.url), 'utf8'),
) as {
  name: string;
  tree_size: number;
  root_hash_hex: string;
  seed_hex: string;
  key_hash_hex: string;
  note_body: string;
  signed_note: string;
};

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Transparency Writer' });
  return { app: buildApp(deps), token };
}

async function createTrustedKey(
  app: TestAppLike,
  token: string,
  input: { keyRef: string; owner: string; validFrom?: string; validTo?: string; supersedesKeyRef?: string },
) {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const create = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      key_ref: input.keyRef,
      algorithm: 'ed25519',
      public_key_pem: publicKeyPem,
      owner: input.owner,
      ...(input.validFrom ? { valid_from: input.validFrom } : {}),
      ...(input.validTo ? { valid_to: input.validTo } : {}),
      ...(input.supersedesKeyRef ? { supersedes_key_ref: input.supersedesKeyRef } : {}),
    }),
  });
  expect(create.status).toBe(201);
  return pair.privateKey;
}

function leafHash(payload: string) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(payload, 'utf8')])).digest();
}

function nodeHash(left: Uint8Array, right: Uint8Array) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x01]), Buffer.from(left), Buffer.from(right)])).digest();
}

function checkpointBody(origin: string, treeSize: number, rootHash: string) {
  return `${origin}\n${treeSize}\n${rootHash}\n`;
}

function signedCheckpointNote(
  body: string,
  signatures:
    | string
    | Array<{
        signer: string;
        detachedSignature: string;
        keyHintBytes?: number[];
      }>,
) {
  const entries = typeof signatures === 'string' ? [{ signer: 'sg-main-log', detachedSignature: signatures }] : signatures;
  const signatureLines = entries.map((entry, index) => {
    const raw = Buffer.from(entry.detachedSignature.replace(/^base64:/, ''), 'base64');
    const keyHint = Buffer.from(entry.keyHintBytes ?? [0, 0, 0, index]);
    const withKeyHint = Buffer.concat([keyHint, raw]).toString('base64');
    return `— ${entry.signer} ${withKeyHint}`;
  });
  return `${body}\n${signatureLines.join('\n')}\n`;
}

/**
 * Spec note-key hint (bigendian32(SHA256(origin + "\n" + 0x01||pubkey))[:4]).
 * Signed-note submissions for Ed25519 trusted keys must carry it — the seam
 * binds note signatures to key identity per the transparency-dev spec.
 */
function specKeyHint(origin: string, privateKey: KeyObject): number[] {
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const keyData = Buffer.concat([Buffer.from([0x01]), publicDer.subarray(publicDer.length - 32)]);
  return [...createHash('sha256').update(origin).update('\n').update(keyData).digest().subarray(0, 4)];
}

describe('transparency log routes', () => {
  it('registers checkpoints, verifies append-only evolution, and validates witness quorum', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKeyV1 = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-v1',
      owner: 'security-team',
    });
    const witnessKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/witness-v1',
      owner: 'witness-ops',
    });

    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-main-log',
        origin: 'sg-main-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-v1',
        log_type: 'tessera',
        witness_quorum: 1,
      }),
    });
    expect(createLog.status).toBe(201);

    const attachWitness = await app.request('/v1/transparency-logs/sg-main-log/witnesses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        witness_id: 'witness-alpha',
        key_ref: 'kms://registry/witness-v1',
        witness_type: 'witness',
      }),
    });
    expect(attachWitness.status).toBe(201);

    const leafOne = leafHash('entry-1');
    const rootOne = `base64:${leafOne.toString('base64')}`;
    const checkpointBodyOne = checkpointBody('sg-main-log', 1, rootOne);
    const checkpointSigOne = `base64:${signBytes(null, Buffer.from(checkpointBodyOne, 'utf8'), checkpointKeyV1).toString('base64')}`;
    const witnessSigOne = `base64:${signBytes(null, Buffer.from(checkpointBodyOne, 'utf8'), witnessKey).toString('base64')}`;

    const createCheckpointOne = await app.request('/v1/transparency-logs/sg-main-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        checkpoint_body: checkpointBodyOne,
        checkpoint_signature: checkpointSigOne,
        witness_attestations: [{ witness_id: 'witness-alpha', signature: witnessSigOne }],
      }),
    });
    expect(createCheckpointOne.status).toBe(200);

    const leafTwo = leafHash('entry-2');
    const rootTwoHash = nodeHash(leafOne, leafTwo);
    const rootTwo = `base64:${rootTwoHash.toString('base64')}`;
    const checkpointBodyTwo = checkpointBody('sg-main-log', 2, rootTwo);
    const checkpointSigTwo = `base64:${signBytes(null, Buffer.from(checkpointBodyTwo, 'utf8'), checkpointKeyV1).toString('base64')}`;
    const witnessSigTwo = `base64:${signBytes(null, Buffer.from(checkpointBodyTwo, 'utf8'), witnessKey).toString('base64')}`;

    const createCheckpointTwo = await app.request('/v1/transparency-logs/sg-main-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        checkpoint_body: checkpointBodyTwo,
        checkpoint_signature: checkpointSigTwo,
        consistency_proof: {
          previous_tree_size: 1,
          previous_root_hash: rootOne,
          proof_hashes: [rootOne, `base64:${leafTwo.toString('base64')}`],
        },
        witness_attestations: [{ witness_id: 'witness-alpha', signature: witnessSigTwo }],
      }),
    });
    expect(createCheckpointTwo.status).toBe(200);

    const leafTwoAlt = leafHash('entry-2-alt');
    const rootTwoAlt = `base64:${nodeHash(leafOne, leafTwoAlt).toString('base64')}`;
    const checkpointBodyObserved = checkpointBody('sg-main-log', 2, rootTwoAlt);
    const checkpointSigObserved = `base64:${signBytes(null, Buffer.from(checkpointBodyObserved, 'utf8'), checkpointKeyV1).toString('base64')}`;
    const observeConflict = await app.request('/v1/transparency-logs/sg-main-log/observations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        checkpoint_body: checkpointBodyObserved,
        checkpoint_signature: checkpointSigObserved,
        observed_from_type: 'peer',
        observed_from_id: 'observer-beta',
      }),
    });
    expect(observeConflict.status).toBe(200);

    const gossip = await app.request('/v1/transparency-logs/sg-main-log/gossip-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        from_witness_id: 'witness-alpha',
        to_witness_id: 'witness-alpha',
        checkpoint_artifact_urn: (await createCheckpointTwo.json() as { checkpoint_artifact_urn: string }).checkpoint_artifact_urn,
      }),
    });
    expect(gossip.status).toBe(200);
    await expect(gossip.json()).resolves.toMatchObject({
      log_id: 'sg-main-log',
      from_witness_id: 'witness-alpha',
      to_witness_id: 'witness-alpha',
      event_type: 'checkpoint_gossip',
    });

    const getLog = await app.request('/v1/transparency-logs/sg-main-log');
    expect(getLog.status).toBe(200);
    await expect(getLog.json()).resolves.toMatchObject({
      transparency_log: {
        properties: {
          log_id: 'sg-main-log',
          checkpoint_key_ref: 'kms://registry/checkpoint-v1',
          witness_quorum: 1,
        },
      },
      current_checkpoint: {
        tree_size: 2,
        root_hash: rootTwo,
        checkpoint_signature_valid: true,
        append_only_verified: true,
      },
      checkpoints: expect.arrayContaining([
        expect.objectContaining({ tree_size: 1, root_hash: rootOne }),
        expect.objectContaining({ tree_size: 2, root_hash: rootTwo }),
      ]),
      witnesses: [
        expect.objectContaining({
          witness_id: 'witness-alpha',
          key_ref: 'kms://registry/witness-v1',
        }),
      ],
    });

    const verifyLog = await app.request('/v1/transparency-logs/sg-main-log/verification');
    expect(verifyLog.status).toBe(200);
    await expect(verifyLog.json()).resolves.toMatchObject({
      checkpoint_signature_valid: true,
      checkpoint_consistency_verified: true,
      trusted_checkpoint_key_resolved: true,
      witness_quorum_required: 1,
      witness_quorum_met: true,
      verification_status: 'consistency_failure',
      checkpoint_history: expect.arrayContaining([
        expect.objectContaining({ tree_size: 1, root_hash: rootOne }),
        expect.objectContaining({ tree_size: 2, root_hash: rootTwo }),
      ]),
      observations: expect.arrayContaining([
        expect.objectContaining({
          observed_from_type: 'peer',
          observed_from_id: 'observer-beta',
          tree_size: 2,
          root_hash: rootTwoAlt,
        }),
      ]),
      disagreements: expect.arrayContaining([
        expect.objectContaining({
          kind: 'same_size_different_root',
          log_id: 'sg-main-log',
        }),
      ]),
      gossip_events: expect.arrayContaining([
        expect.objectContaining({
          log_id: 'sg-main-log',
          from_witness_id: 'witness-alpha',
          to_witness_id: 'witness-alpha',
        }),
      ]),
      witness_checks: [
        expect.objectContaining({
          witness_id: 'witness-alpha',
          trusted_witness_resolved: true,
          trusted_key_resolved: true,
          signature_valid: true,
          verification_status: 'verified',
        }),
      ],
    });

    const timeline = await app.request('/v1/transparency-logs/sg-main-log/timeline');
    expect(timeline.status).toBe(200);
    await expect(timeline.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'checkpoint' }),
        expect.objectContaining({ kind: 'observation' }),
        expect.objectContaining({ kind: 'witness_attestation' }),
        expect.objectContaining({ kind: 'gossip' }),
        expect.objectContaining({ kind: 'disagreement' }),
      ]),
    });
  });

  it('accepts a minimal signed-note checkpoint input and normalizes it', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-note',
      owner: 'security-team',
    });
    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-note-log',
        origin: 'sg-note-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-note',
      }),
    });
    expect(createLog.status).toBe(201);

    const root = `base64:${leafHash('entry-note').toString('base64')}`;
    const body = checkpointBody('sg-note-log', 1, root);
    const detachedSignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), checkpointKey).toString('base64')}`;
    const note = signedCheckpointNote(body, [
      { signer: 'sg-note-log', detachedSignature, keyHintBytes: specKeyHint('sg-note-log', checkpointKey) },
    ]);

    const createCheckpoint = await app.request('/v1/transparency-logs/sg-note-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: note,
      }),
    });
    expect(createCheckpoint.status).toBe(200);
    await expect(createCheckpoint.json()).resolves.toMatchObject({
      tree_size: 1,
      root_hash: root,
      checkpoint_signature_valid: true,
    });

    const verifyLog = await app.request('/v1/transparency-logs/sg-note-log/verification');
    expect(verifyLog.status).toBe(200);
    await expect(verifyLog.json()).resolves.toMatchObject({
      checkpoint_signature_valid: true,
      trusted_checkpoint_key_resolved: true,
    });
  });

  it('accepts a CRLF signed note with ASCII hyphen signature lines', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-crlf-note',
      owner: 'security-team',
    });
    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-crlf-log',
        origin: 'sg-crlf-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-crlf-note',
      }),
    });
    expect(createLog.status).toBe(201);

    const root = `base64:${leafHash('entry-crlf').toString('base64')}`;
    const body = checkpointBody('sg-crlf-log', 1, root);
    const detachedSignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), checkpointKey).toString('base64')}`;
    const note = signedCheckpointNote(body, [
      { signer: 'sg-crlf-log', detachedSignature, keyHintBytes: specKeyHint('sg-crlf-log', checkpointKey) },
    ]).replace(/\n/g, '\r\n').replace('— ', '- ');

    const createCheckpoint = await app.request('/v1/transparency-logs/sg-crlf-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: note,
      }),
    });
    expect(createCheckpoint.status).toBe(200);
    await expect(createCheckpoint.json()).resolves.toMatchObject({
      tree_size: 1,
      root_hash: root,
      checkpoint_signature_valid: true,
      note_format: 'raw_signed_note',
    });
  });

  it('rejects checkpoint payloads that mix signed notes with detached body/signature fields', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-ambiguous',
      owner: 'security-team',
    });
    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-ambiguous-log',
        origin: 'sg-ambiguous-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-ambiguous',
      }),
    });
    expect(createLog.status).toBe(201);

    const root = `base64:${leafHash('entry-ambiguous').toString('base64')}`;
    const body = checkpointBody('sg-ambiguous-log', 1, root);
    const detachedSignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), checkpointKey).toString('base64')}`;
    const note = signedCheckpointNote(body, detachedSignature);

    const createCheckpoint = await app.request('/v1/transparency-logs/sg-ambiguous-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: note,
        checkpoint_body: body,
        checkpoint_signature: detachedSignature,
      }),
    });
    expect(createCheckpoint.status).toBe(400);
    await expect(createCheckpoint.json()).resolves.toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
      },
    });
  });

  it('detects temporal witness disagreement, regression, and quorum drift', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-temporal',
      owner: 'security-team',
    });
    const witnessAlphaKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/witness-alpha-temporal',
      owner: 'witness-ops',
    });
    const witnessBetaKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/witness-beta-temporal',
      owner: 'witness-ops',
    });

    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-temporal-log',
        origin: 'sg-temporal-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-temporal',
        witness_quorum: 2,
      }),
    });
    expect(createLog.status).toBe(201);

    for (const witness of [
      { witness_id: 'witness-alpha', key_ref: 'kms://registry/witness-alpha-temporal' },
      { witness_id: 'witness-beta', key_ref: 'kms://registry/witness-beta-temporal' },
    ]) {
      const attachWitness = await app.request('/v1/transparency-logs/sg-temporal-log/witnesses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...witness,
          witness_type: 'witness',
        }),
      });
      expect(attachWitness.status).toBe(201);
    }

    const leafOne = leafHash('temporal-entry-1');
    const rootOne = `base64:${leafOne.toString('base64')}`;
    const checkpointBodyOne = checkpointBody('sg-temporal-log', 1, rootOne);
    const checkpointSigOne = `base64:${signBytes(null, Buffer.from(checkpointBodyOne, 'utf8'), checkpointKey).toString('base64')}`;
    const witnessAlphaSigOne = `base64:${signBytes(null, Buffer.from(checkpointBodyOne, 'utf8'), witnessAlphaKey).toString('base64')}`;
    const createCheckpointOne = await app.request('/v1/transparency-logs/sg-temporal-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        checkpoint_body: checkpointBodyOne,
        checkpoint_signature: checkpointSigOne,
        witness_attestations: [{ witness_id: 'witness-alpha', signature: witnessAlphaSigOne }],
      }),
    });
    expect(createCheckpointOne.status).toBe(200);

    const leafTwo = leafHash('temporal-entry-2');
    const rootTwoHash = nodeHash(leafOne, leafTwo);
    const rootTwo = `base64:${rootTwoHash.toString('base64')}`;
    const checkpointBodyTwo = checkpointBody('sg-temporal-log', 2, rootTwo);
    const checkpointSigTwo = `base64:${signBytes(null, Buffer.from(checkpointBodyTwo, 'utf8'), checkpointKey).toString('base64')}`;
    const witnessAlphaSigTwo = `base64:${signBytes(null, Buffer.from(checkpointBodyTwo, 'utf8'), witnessAlphaKey).toString('base64')}`;
    const witnessBetaSigTwo = `base64:${signBytes(null, Buffer.from(checkpointBodyTwo, 'utf8'), witnessBetaKey).toString('base64')}`;
    const createCheckpointTwo = await app.request('/v1/transparency-logs/sg-temporal-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        checkpoint_body: checkpointBodyTwo,
        checkpoint_signature: checkpointSigTwo,
        consistency_proof: {
          previous_tree_size: 1,
          previous_root_hash: rootOne,
          proof_hashes: [rootOne, `base64:${leafTwo.toString('base64')}`],
        },
        witness_attestations: [
          { witness_id: 'witness-alpha', signature: witnessAlphaSigTwo },
          { witness_id: 'witness-beta', signature: witnessBetaSigTwo },
        ],
      }),
    });
    expect(createCheckpointTwo.status).toBe(200);

    const leafTwoAlt = leafHash('temporal-entry-2-alt');
    const rootTwoAlt = `base64:${nodeHash(leafOne, leafTwoAlt).toString('base64')}`;
    const checkpointBodyTwoAlt = checkpointBody('sg-temporal-log', 2, rootTwoAlt);
    const checkpointSigTwoAlt = `base64:${signBytes(null, Buffer.from(checkpointBodyTwoAlt, 'utf8'), checkpointKey).toString('base64')}`;
    const times = {
      witnessAlphaRootTwo: '2026-01-01T00:00:00.000Z',
      witnessBetaRootTwoAlt: '2026-01-01T00:01:00.000Z',
      witnessAlphaRootTwoAlt: '2026-01-01T00:02:00.000Z',
      witnessAlphaRegression: '2026-01-01T00:03:00.000Z',
    };

    for (const observation of [
      {
        checkpoint_body: checkpointBodyTwo,
        checkpoint_signature: checkpointSigTwo,
        observed_from_type: 'witness',
        observed_from_id: 'witness-alpha',
        observed_at: times.witnessAlphaRootTwo,
      },
      {
        checkpoint_body: checkpointBodyTwoAlt,
        checkpoint_signature: checkpointSigTwoAlt,
        observed_from_type: 'witness',
        observed_from_id: 'witness-beta',
        observed_at: times.witnessBetaRootTwoAlt,
      },
      {
        checkpoint_body: checkpointBodyTwoAlt,
        checkpoint_signature: checkpointSigTwoAlt,
        observed_from_type: 'witness',
        observed_from_id: 'witness-alpha',
        observed_at: times.witnessAlphaRootTwoAlt,
      },
      {
        checkpoint_body: checkpointBodyOne,
        checkpoint_signature: checkpointSigOne,
        observed_from_type: 'witness',
        observed_from_id: 'witness-alpha',
        observed_at: times.witnessAlphaRegression,
      },
    ]) {
      const createObservation = await app.request('/v1/transparency-logs/sg-temporal-log/observations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(observation),
      });
      expect(createObservation.status).toBe(200);
    }

    const verifyLog = await app.request('/v1/transparency-logs/sg-temporal-log/verification');
    expect(verifyLog.status).toBe(200);
    const verification = (await verifyLog.json()) as {
      verification_status: string;
      checkpoint_history: Array<{
        tree_size: number;
        witness_quorum_satisfied?: boolean;
      }>;
      disagreements: Array<{
        kind: string;
        reason: string;
        occurred_at?: string;
        source_ids?: string[];
      }>;
    };
    expect(verification.verification_status).toBe('consistency_failure');
    expect(verification.checkpoint_history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tree_size: 1,
          witness_quorum_satisfied: false,
        }),
        expect.objectContaining({
          tree_size: 2,
          witness_quorum_satisfied: true,
        }),
      ]),
    );
    expect(verification.disagreements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'witness_disagreement',
          source_ids: expect.arrayContaining(['witness-alpha', 'witness-beta']),
        }),
        expect.objectContaining({
          kind: 'witness_equivocation',
          source_ids: ['witness-alpha'],
          occurred_at: times.witnessAlphaRootTwoAlt,
        }),
        expect.objectContaining({
          kind: 'checkpoint_regression',
          source_ids: ['witness-alpha'],
          occurred_at: times.witnessAlphaRegression,
        }),
        expect.objectContaining({
          kind: 'quorum_drift',
          source_ids: ['sg-temporal-log'],
          reason: expect.stringContaining('2/2 valid witness attestations'),
        }),
      ]),
    );

    const timeline = await app.request('/v1/transparency-logs/sg-temporal-log/timeline');
    expect(timeline.status).toBe(200);
    await expect(timeline.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: 'disagreement',
          occurred_at: times.witnessAlphaRegression,
        }),
      ]),
    });
  });

  it('preserves richer provenance on observations and gossip events', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-provenance',
      owner: 'security-team',
    });
    await createTrustedKey(app, token, {
      keyRef: 'kms://registry/witness-provenance-alpha',
      owner: 'witness-ops',
    });
    await createTrustedKey(app, token, {
      keyRef: 'kms://registry/witness-provenance-beta',
      owner: 'witness-ops',
    });

    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-provenance-log',
        origin: 'sg-provenance-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-provenance',
      }),
    });
    expect(createLog.status).toBe(201);

    for (const witness of [
      { witness_id: 'witness-alpha', key_ref: 'kms://registry/witness-provenance-alpha' },
      { witness_id: 'witness-beta', key_ref: 'kms://registry/witness-provenance-beta' },
    ]) {
      const attachWitness = await app.request('/v1/transparency-logs/sg-provenance-log/witnesses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...witness,
          witness_type: 'witness',
        }),
      });
      expect(attachWitness.status).toBe(201);
    }

    const root = `base64:${leafHash('entry-provenance').toString('base64')}`;
    const body = checkpointBody('sg-provenance-log', 1, root);
    const detachedSignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), checkpointKey).toString('base64')}`;
    const note = signedCheckpointNote(body, [
      { signer: 'sg-provenance-log', detachedSignature, keyHintBytes: specKeyHint('sg-provenance-log', checkpointKey) },
    ]);
    const expectedPayloadSha = createHash('sha256').update(note, 'utf8').digest('hex');

    const createCheckpoint = await app.request('/v1/transparency-logs/sg-provenance-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: note,
      }),
    });
    expect(createCheckpoint.status).toBe(200);
    const checkpointArtifactUrn = (await createCheckpoint.json() as { checkpoint_artifact_urn: string }).checkpoint_artifact_urn;

    const createObservation = await app.request('/v1/transparency-logs/sg-provenance-log/observations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: note,
        observed_from_type: 'peer',
        observed_from_id: 'observer-beta',
        observed_at: '2026-01-02T00:10:00.000Z',
        source_channel: 'https_poll',
        observer_id: 'collector-1',
        observer_type: 'system',
        relay_from_type: 'distributor',
        relay_from_id: 'mirror-a',
        relay_hop_count: 2,
        source_checkpoint_occurred_at: '2026-01-02T00:00:00.000Z',
      }),
    });
    expect(createObservation.status).toBe(200);
    await expect(createObservation.json()).resolves.toMatchObject({
      observed_from_type: 'peer',
      observed_from_id: 'observer-beta',
      note_format: 'raw_signed_note',
      parse_strategy: 'signed_note',
      payload_sha256: expectedPayloadSha,
      source_channel: 'https_poll',
      observer_id: 'collector-1',
      observer_type: 'system',
      relay_from_type: 'distributor',
      relay_from_id: 'mirror-a',
      relay_hop_count: 2,
      source_checkpoint_occurred_at: '2026-01-02T00:00:00.000Z',
    });

    const createGossip = await app.request('/v1/transparency-logs/sg-provenance-log/gossip-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        from_witness_id: 'witness-alpha',
        to_witness_id: 'witness-beta',
        checkpoint_artifact_urn: checkpointArtifactUrn,
        occurred_at: '2026-01-02T00:11:00.000Z',
        source_channel: 'witness_rpc',
        relayed_by_id: 'relay-gateway-1',
        relay_hop_count: 3,
        source_checkpoint_occurred_at: '2026-01-02T00:00:00.000Z',
      }),
    });
    expect(createGossip.status).toBe(200);
    await expect(createGossip.json()).resolves.toMatchObject({
      from_witness_id: 'witness-alpha',
      to_witness_id: 'witness-beta',
      note_format: 'raw_signed_note',
      parse_strategy: 'signed_note',
      payload_sha256: expectedPayloadSha,
      source_channel: 'witness_rpc',
      relayed_by_id: 'relay-gateway-1',
      relay_hop_count: 3,
      source_checkpoint_occurred_at: '2026-01-02T00:00:00.000Z',
    });

    const verifyLog = await app.request('/v1/transparency-logs/sg-provenance-log/verification');
    expect(verifyLog.status).toBe(200);
    await expect(verifyLog.json()).resolves.toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({
          observed_from_id: 'observer-beta',
          note_format: 'raw_signed_note',
          parse_strategy: 'signed_note',
          payload_sha256: expectedPayloadSha,
          source_channel: 'https_poll',
          observer_id: 'collector-1',
          observer_type: 'system',
          relay_from_type: 'distributor',
          relay_from_id: 'mirror-a',
          relay_hop_count: 2,
          source_checkpoint_occurred_at: '2026-01-02T00:00:00.000Z',
        }),
      ]),
      gossip_events: expect.arrayContaining([
        expect.objectContaining({
          from_witness_id: 'witness-alpha',
          to_witness_id: 'witness-beta',
          note_format: 'raw_signed_note',
          parse_strategy: 'signed_note',
          payload_sha256: expectedPayloadSha,
          source_channel: 'witness_rpc',
          relayed_by_id: 'relay-gateway-1',
          relay_hop_count: 3,
          source_checkpoint_occurred_at: '2026-01-02T00:00:00.000Z',
        }),
      ]),
    });
  });

  it('preserves parsed multi-signature note metadata while keeping primary checkpoint verification compatible', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-multisig',
      owner: 'security-team',
    });
    const cosignerKey = generateKeyPairSync('ed25519').privateKey;
    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-multisig-log',
        origin: 'sg-multisig-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-multisig',
      }),
    });
    expect(createLog.status).toBe(201);

    const root = `base64:${leafHash('entry-multisig').toString('base64')}`;
    const body = checkpointBody('sg-multisig-log', 1, root);
    const detachedSignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), checkpointKey).toString('base64')}`;
    const cosignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), cosignerKey).toString('base64')}`;
    const primaryHint = specKeyHint('sg-multisig-log', checkpointKey);
    const note = signedCheckpointNote(body, [
      {
        signer: 'sg-multisig-log',
        detachedSignature,
        keyHintBytes: primaryHint,
      },
      {
        signer: 'witness-beta',
        detachedSignature: cosignature,
        keyHintBytes: [0, 0, 0, 2],
      },
    ]);

    const createCheckpoint = await app.request('/v1/transparency-logs/sg-multisig-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: note,
      }),
    });
    expect(createCheckpoint.status).toBe(200);
    await expect(createCheckpoint.json()).resolves.toMatchObject({
      tree_size: 1,
      root_hash: root,
      checkpoint_signature_valid: true,
      note_format: 'raw_signed_note',
      signature_count: 2,
      signed_note_signer: 'sg-multisig-log',
      signed_note_key_hint: `base64:${Buffer.from(primaryHint).toString('base64')}`,
      signatures: [
        expect.objectContaining({
          signature_index: 0,
          signature_role: 'checkpoint',
          signer: 'sg-multisig-log',
          key_hint: `base64:${Buffer.from(primaryHint).toString('base64')}`,
        }),
        expect.objectContaining({
          signature_index: 1,
          signature_role: 'cosignature',
          signer: 'witness-beta',
          key_hint: 'base64:AAAAAg==',
        }),
      ],
    });
  });

  it('rejects signed notes that do not bind to the trusted Ed25519 key hint', async () => {
    const { app, token } = await buildTestApp();
    const checkpointKey = await createTrustedKey(app, token, {
      keyRef: 'kms://registry/checkpoint-hint',
      owner: 'security-team',
    });
    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-hint-log',
        origin: 'sg-hint-log',
        checkpoint_key_ref: 'kms://registry/checkpoint-hint',
      }),
    });
    expect(createLog.status).toBe(201);

    const root = `base64:${leafHash('entry-hint').toString('base64')}`;
    const body = checkpointBody('sg-hint-log', 1, root);
    const detachedSignature = `base64:${signBytes(null, Buffer.from(body, 'utf8'), checkpointKey).toString('base64')}`;
    const note = signedCheckpointNote(body, [
      { signer: 'sg-hint-log', detachedSignature, keyHintBytes: [0, 0, 0, 9] },
    ]);

    const createCheckpoint = await app.request('/v1/transparency-logs/sg-hint-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ signed_note: note }),
    });
    expect(createCheckpoint.status).toBe(409);
    await expect(createCheckpoint.json()).resolves.toMatchObject({
      error: { code: 'CHECKPOINT_NOTE_KEY_HINT_MISMATCH' },
    });
  });

  it('accepts a real transparency-dev fixture note for a matching Ed25519 key', async () => {
    const { app, token } = await buildTestApp();
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(SPEC_FIXTURE.seed_hex, 'hex')]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const registerKey = await app.request('/v1/public-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        key_ref: 'kms://registry/checkpoint-spec-fixture',
        algorithm: 'ed25519',
        public_key_pem: publicKeyPem,
        owner: 'security-team',
      }),
    });
    expect(registerKey.status).toBe(201);
    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'spec-fixture-log',
        origin: SPEC_FIXTURE.name,
        checkpoint_key_ref: 'kms://registry/checkpoint-spec-fixture',
      }),
    });
    expect(createLog.status).toBe(201);

    const createCheckpoint = await app.request('/v1/transparency-logs/spec-fixture-log/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ signed_note: SPEC_FIXTURE.signed_note }),
    });
    expect(createCheckpoint.status).toBe(200);
    await expect(createCheckpoint.json()).resolves.toMatchObject({
      tree_size: SPEC_FIXTURE.tree_size,
      root_hash: Buffer.from(SPEC_FIXTURE.root_hash_hex, 'hex').toString('base64'),
      checkpoint_signature_valid: true,
      note_format: 'raw_signed_note',
      signed_note_signer: SPEC_FIXTURE.name,
      signed_note_key_hint: `base64:${Buffer.from(SPEC_FIXTURE.key_hash_hex, 'hex').toString('base64')}`,
    });
  });
});
