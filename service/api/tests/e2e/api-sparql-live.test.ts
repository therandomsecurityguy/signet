import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { KeyObject } from 'node:crypto';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const enabled = process.env['ENABLE_LIVE_SPARQL_E2E'] === '1';
const queryUrl = process.env['REGISTRY_SPARQL_QUERY_URL'];
const updateUrl = process.env['REGISTRY_SPARQL_UPDATE_URL'];
const username = process.env['REGISTRY_SPARQL_USERNAME'];
const password = process.env['REGISTRY_SPARQL_PASSWORD'];
const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

const maybeIt = enabled ? it : it.skip;

describe('API live SPARQL e2e', () => {
  maybeIt('runs against a real SPARQL endpoint', async () => {
    if (!queryUrl || !updateUrl || !username || !password) {
      throw new Error(
        'REGISTRY_SPARQL_QUERY_URL, REGISTRY_SPARQL_UPDATE_URL, REGISTRY_SPARQL_USERNAME, and REGISTRY_SPARQL_PASSWORD are required.',
      );
    }

    await clearAll(updateUrl, username, password);

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-live-sparql-'));
    const objectsDir = path.join(tmp, 'objects');

    try {
      const first = await startServer({
        REGISTRY_GRAPH_BACKEND: 'sparql',
        REGISTRY_SPARQL_QUERY_URL: queryUrl,
        REGISTRY_SPARQL_UPDATE_URL: updateUrl,
        REGISTRY_SPARQL_USERNAME: username,
        REGISTRY_SPARQL_PASSWORD: password,
        REGISTRY_OBJECTS_DIR: objectsDir,
        DATABASE_URL: path.join(tmp, 'api.db'),
      });

      const createSkill = await fetch(`${first.baseUrl}/v1/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${first.token}` },
        body: JSON.stringify({
          skill_key: 'skill:live-sparql',
          display_name: 'Live SPARQL Skill',
        }),
      });
      expect(createSkill.status).toBe(201);

      const createAgent = await fetch(`${first.baseUrl}/v1/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${first.token}` },
        body: JSON.stringify({
          agent_key: 'cursor:live-sparql',
          display_name: 'Live SPARQL Agent',
          skill_refs: [{ skill_key: 'skill:live-sparql' }],
          artifact: {
            content: 'live sparql artifact',
            original_path: 'agent/live-sparql/AGENTS.md',
          },
        }),
      });
      expect(createAgent.status).toBe(201);

      await stopServer(first.server);

      const second = await startServer({
        REGISTRY_GRAPH_BACKEND: 'sparql',
        REGISTRY_SPARQL_QUERY_URL: queryUrl,
        REGISTRY_SPARQL_UPDATE_URL: updateUrl,
        REGISTRY_SPARQL_USERNAME: username,
        REGISTRY_SPARQL_PASSWORD: password,
        REGISTRY_OBJECTS_DIR: objectsDir,
        DATABASE_URL: path.join(tmp, 'api.db'),
      });

      const getAgent = await fetch(`${second.baseUrl}/v1/agents/cursor:live-sparql`);
      expect(getAgent.status).toBe(200);
      await expect(getAgent.json()).resolves.toMatchObject({
        agent: {
          urn: 'urn:sg:agent:cursor:live-sparql',
        },
        skills: [
          {
            skill_urn: 'urn:sg:skill:skill:live-sparql',
          },
        ],
      });

      const sameCreate = await fetch(`${second.baseUrl}/v1/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${second.token}` },
        body: JSON.stringify({
          agent_key: 'cursor:live-sparql',
          display_name: 'Live SPARQL Agent',
          skill_refs: [{ skill_key: 'skill:live-sparql' }],
          artifact: {
            content: 'live sparql artifact',
            original_path: 'agent/live-sparql/AGENTS.md',
          },
        }),
      });
      expect(sameCreate.status).toBe(200);
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await clearAll(updateUrl, username, password);
    }
  }, 30_000);

  maybeIt('persists a transparency sample graph against a real SPARQL endpoint', async () => {
    if (!queryUrl || !updateUrl || !username || !password) {
      throw new Error(
        'REGISTRY_SPARQL_QUERY_URL, REGISTRY_SPARQL_UPDATE_URL, REGISTRY_SPARQL_USERNAME, and REGISTRY_SPARQL_PASSWORD are required.',
      );
    }

    await clearAll(updateUrl, username, password);

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-live-sparql-transparency-'));
    const objectsDir = path.join(tmp, 'objects');
    const dbFile = path.join(tmp, 'api.db');

    try {
      const first = await startServer({
        REGISTRY_GRAPH_BACKEND: 'sparql',
        REGISTRY_SPARQL_QUERY_URL: queryUrl,
        REGISTRY_SPARQL_UPDATE_URL: updateUrl,
        REGISTRY_SPARQL_USERNAME: username,
        REGISTRY_SPARQL_PASSWORD: password,
        REGISTRY_OBJECTS_DIR: objectsDir,
        DATABASE_URL: dbFile,
      });

      const seeded = await seedTransparencySampleGraph(first.baseUrl, first.token);

      const beforeRestart = await fetch(`${first.baseUrl}/v1/transparency-logs/${encodeURIComponent(seeded.logId)}/verification`);
      expect(beforeRestart.status).toBe(200);
      await expect(beforeRestart.json()).resolves.toMatchObject({
        checkpoint_signature_valid: true,
        checkpoint_consistency_verified: true,
        trusted_checkpoint_key_resolved: true,
        witness_quorum_required: 2,
        witness_quorum_met: true,
        verification_status: 'consistency_failure',
        checkpoint_history: expect.arrayContaining([
          expect.objectContaining({ tree_size: 1, root_hash: seeded.rootOne }),
          expect.objectContaining({ tree_size: 2, root_hash: seeded.rootTwo }),
        ]),
      });

      await stopServer(first.server);

      const second = await startServer({
        REGISTRY_GRAPH_BACKEND: 'sparql',
        REGISTRY_SPARQL_QUERY_URL: queryUrl,
        REGISTRY_SPARQL_UPDATE_URL: updateUrl,
        REGISTRY_SPARQL_USERNAME: username,
        REGISTRY_SPARQL_PASSWORD: password,
        REGISTRY_OBJECTS_DIR: objectsDir,
        DATABASE_URL: dbFile,
      });

      const getLog = await fetch(`${second.baseUrl}/v1/transparency-logs/${encodeURIComponent(seeded.logId)}`);
      expect(getLog.status).toBe(200);
      await expect(getLog.json()).resolves.toMatchObject({
        transparency_log: {
          properties: {
            log_id: seeded.logId,
            witness_quorum: 2,
            checkpoint_key_ref: 'kms://registry/sample-checkpoint',
          },
        },
        current_checkpoint: expect.objectContaining({
          tree_size: 2,
          root_hash: seeded.rootTwo,
        }),
        witnesses: expect.arrayContaining([
          expect.objectContaining({ witness_id: 'witness-alpha' }),
          expect.objectContaining({ witness_id: 'witness-beta' }),
        ]),
      });

      const verifyLog = await fetch(`${second.baseUrl}/v1/transparency-logs/${encodeURIComponent(seeded.logId)}/verification`);
      expect(verifyLog.status).toBe(200);
      await expect(verifyLog.json()).resolves.toMatchObject({
        witness_quorum_required: 2,
        witness_quorum_met: true,
        verification_status: 'consistency_failure',
        checkpoint_history: expect.arrayContaining([
          expect.objectContaining({
            tree_size: 1,
            witness_quorum_satisfied: false,
          }),
          expect.objectContaining({
            tree_size: 2,
            witness_quorum_satisfied: true,
          }),
        ]),
        observations: expect.arrayContaining([
          expect.objectContaining({
            observed_from_type: 'peer',
            observed_from_id: 'observer-beta',
            note_format: 'raw_signed_note',
            parse_strategy: 'signed_note',
            payload_sha256: seeded.checkpointTwoAltPayloadSha,
            source_channel: 'https_poll',
            observer_id: 'collector-1',
            relay_from_type: 'distributor',
            relay_from_id: 'mirror-a',
            relay_hop_count: 2,
          }),
        ]),
        disagreements: expect.arrayContaining([
          expect.objectContaining({ kind: 'same_size_different_root' }),
          expect.objectContaining({ kind: 'witness_disagreement' }),
          expect.objectContaining({ kind: 'quorum_drift' }),
        ]),
        gossip_events: expect.arrayContaining([
          expect.objectContaining({
            from_witness_id: 'witness-alpha',
            to_witness_id: 'witness-beta',
            note_format: 'raw_signed_note',
            parse_strategy: 'signed_note',
            payload_sha256: seeded.checkpointTwoPayloadSha,
            source_channel: 'witness_rpc',
            relayed_by_id: 'relay-gateway-1',
            relay_hop_count: 1,
          }),
        ]),
      });

      const timeline = await fetch(`${second.baseUrl}/v1/transparency-logs/${encodeURIComponent(seeded.logId)}/timeline`);
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
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await clearAll(updateUrl, username, password);
    }
  }, 60_000);
});

async function startServer(overrides: Record<string, string>) {
  const port = await getFreePort();
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    HOST: '127.0.0.1',
    PORT: String(port),
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Live SPARQL Writer' });
  const app = buildApp(deps);

  const started = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: env.HOST,
        port: env.PORT,
      },
      (info) => {
        resolve({ server, port: info.port });
      },
    );
  });

  servers.push(started.server);
  return {
    server: started.server,
    baseUrl: `http://127.0.0.1:${started.port}`,
    token,
  };
}

async function stopServer(server: ServerType) {
  const idx = servers.indexOf(server);
  if (idx >= 0) servers.splice(idx, 1);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function clearAll(url: string, user: string, pass: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/sparql-update',
      authorization: `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`,
    },
    body: 'CLEAR ALL',
  });
  if (!res.ok) {
    throw new Error(`Failed to clear SPARQL endpoint (${res.status})`);
  }
}

async function seedTransparencySampleGraph(baseUrl: string, token: string) {
  const logId = 'sg-live-sparql-sample-log';
  const checkpointKey = await createTrustedKey(baseUrl, token, {
    keyRef: 'kms://registry/sample-checkpoint',
    owner: 'security-team',
  });
  const witnessAlphaKey = await createTrustedKey(baseUrl, token, {
    keyRef: 'kms://registry/sample-witness-alpha',
    owner: 'witness-ops',
  });
  const witnessBetaKey = await createTrustedKey(baseUrl, token, {
    keyRef: 'kms://registry/sample-witness-beta',
    owner: 'witness-ops',
  });
  const noteCosigner = generateKeyPairSync('ed25519').privateKey;

  const createLog = await fetch(`${baseUrl}/v1/transparency-logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      log_id: logId,
      origin: logId,
      checkpoint_key_ref: 'kms://registry/sample-checkpoint',
      log_type: 'tessera',
      witness_quorum: 2,
    }),
  });
  expect(createLog.status).toBe(201);

  for (const witness of [
    { witness_id: 'witness-alpha', key_ref: 'kms://registry/sample-witness-alpha' },
    { witness_id: 'witness-beta', key_ref: 'kms://registry/sample-witness-beta' },
  ]) {
    const attachWitness = await fetch(`${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/witnesses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ...witness,
        witness_type: 'witness',
      }),
    });
    expect(attachWitness.status).toBe(201);
  }

  const leafOne = leafHash('live-sparql-entry-1');
  const rootOne = `base64:${leafOne.toString('base64')}`;
  const checkpointBodyOne = checkpointBody(logId, 1, rootOne);
  const checkpointSigOne = encodeSignature(checkpointBodyOne, checkpointKey);
  const witnessSigOne = encodeSignature(checkpointBodyOne, witnessAlphaKey);
  const createCheckpointOne = await fetch(`${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      checkpoint_body: checkpointBodyOne,
      checkpoint_signature: checkpointSigOne,
      witness_attestations: [{ witness_id: 'witness-alpha', signature: witnessSigOne }],
    }),
  });
  expect(createCheckpointOne.status).toBe(200);

  const leafTwo = leafHash('live-sparql-entry-2');
  const rootTwoHash = nodeHash(leafOne, leafTwo);
  const rootTwo = `base64:${rootTwoHash.toString('base64')}`;
  const checkpointBodyTwo = checkpointBody(logId, 2, rootTwo);
  const checkpointSigTwo = encodeSignature(checkpointBodyTwo, checkpointKey);
  const checkpointTwoNote = signedCheckpointNote(checkpointBodyTwo, [
    {
      signer: logId,
      detachedSignature: checkpointSigTwo,
      keyHintBytes: [0, 0, 0, 1],
    },
    {
      signer: 'witness-cosignature',
      detachedSignature: encodeSignature(checkpointBodyTwo, noteCosigner),
      keyHintBytes: [0, 0, 0, 2],
    },
  ]);
  const witnessAlphaSigTwo = encodeSignature(checkpointBodyTwo, witnessAlphaKey);
  const witnessBetaSigTwo = encodeSignature(checkpointBodyTwo, witnessBetaKey);
  const createCheckpointTwo = await fetch(`${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      signed_note: checkpointTwoNote,
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
  const checkpointTwoArtifactUrn = (await createCheckpointTwo.json() as { checkpoint_artifact_urn: string }).checkpoint_artifact_urn;

  const leafTwoAlt = leafHash('live-sparql-entry-2-alt');
  const rootTwoAlt = `base64:${nodeHash(leafOne, leafTwoAlt).toString('base64')}`;
  const checkpointBodyTwoAlt = checkpointBody(logId, 2, rootTwoAlt);
  const checkpointSigTwoAlt = encodeSignature(checkpointBodyTwoAlt, checkpointKey);
  const checkpointTwoAltNote = signedCheckpointNote(checkpointBodyTwoAlt, checkpointSigTwoAlt);
  const createObservation = await fetch(`${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      signed_note: checkpointTwoAltNote,
      observed_from_type: 'peer',
      observed_from_id: 'observer-beta',
      observed_at: '2026-01-05T00:10:00.000Z',
      source_channel: 'https_poll',
      observer_id: 'collector-1',
      observer_type: 'system',
      relay_from_type: 'distributor',
      relay_from_id: 'mirror-a',
      relay_hop_count: 2,
      source_checkpoint_occurred_at: '2026-01-05T00:00:00.000Z',
    }),
  });
  expect(createObservation.status).toBe(200);

  const createWitnessObservation = await fetch(`${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      signed_note: checkpointTwoNote,
      observed_from_type: 'witness',
      observed_from_id: 'witness-alpha',
      observed_at: '2026-01-05T00:11:00.000Z',
      source_channel: 'witness_rpc',
      observer_id: 'collector-1',
      observer_type: 'system',
    }),
  });
  expect(createWitnessObservation.status).toBe(200);

  const createConflictingWitnessObservation = await fetch(
    `${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/observations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signed_note: checkpointTwoAltNote,
        observed_from_type: 'witness',
        observed_from_id: 'witness-beta',
        observed_at: '2026-01-05T00:12:00.000Z',
        source_channel: 'witness_rpc',
        observer_id: 'collector-2',
        observer_type: 'system',
      }),
    },
  );
  expect(createConflictingWitnessObservation.status).toBe(200);

  const createGossip = await fetch(`${baseUrl}/v1/transparency-logs/${encodeURIComponent(logId)}/gossip-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      from_witness_id: 'witness-alpha',
      to_witness_id: 'witness-beta',
      checkpoint_artifact_urn: checkpointTwoArtifactUrn,
      occurred_at: '2026-01-05T00:13:00.000Z',
      source_channel: 'witness_rpc',
      relayed_by_id: 'relay-gateway-1',
      relay_hop_count: 1,
      source_checkpoint_occurred_at: '2026-01-05T00:00:00.000Z',
    }),
  });
  expect(createGossip.status).toBe(200);

  return {
    logId,
    rootOne,
    rootTwo,
    checkpointTwoPayloadSha: sha256Hex(Buffer.from(checkpointTwoNote, 'utf8')),
    checkpointTwoAltPayloadSha: sha256Hex(Buffer.from(checkpointTwoAltNote, 'utf8')),
  };
}

async function createTrustedKey(
  baseUrl: string,
  token: string,
  input: {
    keyRef: string;
    owner: string;
  },
) {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const create = await fetch(`${baseUrl}/v1/public-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      key_ref: input.keyRef,
      algorithm: 'ed25519',
      public_key_pem: publicKeyPem,
      owner: input.owner,
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

function encodeSignature(body: string, privateKey: KeyObject) {
  return `base64:${signBytes(null, Buffer.from(body, 'utf8'), privateKey).toString('base64')}`;
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

function sha256Hex(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve free port.'));
        return;
      }

      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}
