import { createHash, createPublicKey, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { RegistryOperatorApiClient } from '../clients/api.js';

export const TransparencySampleGraphSpecSchema = z.object({
  sampleSlug: z.string().min(1),
  logId: z.string().min(1),
  checkpointKeyRef: z.string().min(1),
  witnessAlphaKeyRef: z.string().min(1),
  witnessBetaKeyRef: z.string().min(1),
  entryOneLabel: z.string().min(1),
  entryTwoLabel: z.string().min(1),
  entryTwoAltLabel: z.string().min(1),
  signerName: z.string().min(1),
  observationOccurredAt: z.string().min(1),
  witnessAlphaObservationAt: z.string().min(1),
  witnessBetaObservationAt: z.string().min(1),
  gossipOccurredAt: z.string().min(1),
  sourceCheckpointOccurredAt: z.string().min(1),
});

export type TransparencySampleGraphSpec = z.infer<typeof TransparencySampleGraphSpecSchema>;

export type SeedTransparencySampleGraphInput = {
  sampleSlug?: string;
  day?: string;
  spec?: TransparencySampleGraphSpec;
};

export type SeededTransparencySampleGraph = {
  spec: TransparencySampleGraphSpec;
  rootOne: string;
  rootTwo: string;
  checkpointTwoPayloadSha: string;
  checkpointTwoAltPayloadSha: string;
};

export function buildTransparencySampleGraphSpec(input: SeedTransparencySampleGraphInput = {}): TransparencySampleGraphSpec {
  const sampleSlug = input.sampleSlug ?? 'transparency-sample';
  const day = input.day ?? '2026-01-03';
  return {
    sampleSlug,
    logId: `sg-${sampleSlug}-log`,
    checkpointKeyRef: `kms://registry/${sampleSlug}-checkpoint`,
    witnessAlphaKeyRef: `kms://registry/${sampleSlug}-witness-alpha`,
    witnessBetaKeyRef: `kms://registry/${sampleSlug}-witness-beta`,
    entryOneLabel: `${sampleSlug}-entry-1`,
    entryTwoLabel: `${sampleSlug}-entry-2`,
    entryTwoAltLabel: `${sampleSlug}-entry-2-alt`,
    signerName: `sg-${sampleSlug}-cosignature`,
    observationOccurredAt: `${day}T00:10:00.000Z`,
    witnessAlphaObservationAt: `${day}T00:11:00.000Z`,
    witnessBetaObservationAt: `${day}T00:12:00.000Z`,
    gossipOccurredAt: `${day}T00:13:00.000Z`,
    sourceCheckpointOccurredAt: `${day}T00:00:00.000Z`,
  };
}

export async function readTransparencySampleGraphSpec(specPath: string): Promise<TransparencySampleGraphSpec> {
  return TransparencySampleGraphSpecSchema.parse(JSON.parse(await readFile(specPath, 'utf8')));
}

export async function seedTransparencySampleGraph(
  api: RegistryOperatorApiClient,
  apiToken: string,
  input: SeedTransparencySampleGraphInput = {},
): Promise<SeededTransparencySampleGraph> {
  const spec = input.spec ?? buildTransparencySampleGraphSpec(input);
  const checkpointKey = await createTrustedKey(api, apiToken, spec.checkpointKeyRef, 'security-team');
  const witnessAlphaKey = await createTrustedKey(api, apiToken, spec.witnessAlphaKeyRef, 'witness-ops');
  const witnessBetaKey = await createTrustedKey(api, apiToken, spec.witnessBetaKeyRef, 'witness-ops');
  const noteCosigner = generateKeyPairSync('ed25519').privateKey;

  await api.createTransparencyLog(
    {
      log_id: spec.logId,
      origin: spec.logId,
      checkpoint_key_ref: spec.checkpointKeyRef,
      log_type: 'tessera',
      witness_quorum: 2,
    },
    apiToken,
  );

  for (const witness of [
    { witness_id: 'witness-alpha', key_ref: spec.witnessAlphaKeyRef },
    { witness_id: 'witness-beta', key_ref: spec.witnessBetaKeyRef },
  ]) {
    await api.createTransparencyWitness(
      spec.logId,
      {
        ...witness,
        witness_type: 'witness',
      },
      apiToken,
    );
  }

  const leafOne = leafHash(spec.entryOneLabel);
  const rootOne = `base64:${leafOne.toString('base64')}`;
  const checkpointBodyOne = checkpointBody(spec.logId, 1, rootOne);
  const checkpointSigOne = encodeSignature(checkpointBodyOne, checkpointKey);
  const witnessSigOne = encodeSignature(checkpointBodyOne, witnessAlphaKey);
  await api.createTransparencyCheckpoint(
    spec.logId,
    {
      checkpoint_body: checkpointBodyOne,
      checkpoint_signature: checkpointSigOne,
      witness_attestations: [{ witness_id: 'witness-alpha', signature: witnessSigOne }],
    },
    apiToken,
  );

  const leafTwo = leafHash(spec.entryTwoLabel);
  const rootTwoHash = nodeHash(leafOne, leafTwo);
  const rootTwo = `base64:${rootTwoHash.toString('base64')}`;
  const checkpointBodyTwo = checkpointBody(spec.logId, 2, rootTwo);
  const checkpointSigTwo = encodeSignature(checkpointBodyTwo, checkpointKey);
  const checkpointTwoNote = signedCheckpointNote(checkpointBodyTwo, [
    {
      signer: spec.logId,
      detachedSignature: checkpointSigTwo,
      keyHintBytes: specKeyHint(spec.logId, checkpointKey),
    },
    {
      signer: spec.signerName,
      detachedSignature: encodeSignature(checkpointBodyTwo, noteCosigner),
      keyHintBytes: [0, 0, 0, 2],
    },
  ]);
  const witnessAlphaSigTwo = encodeSignature(checkpointBodyTwo, witnessAlphaKey);
  const witnessBetaSigTwo = encodeSignature(checkpointBodyTwo, witnessBetaKey);
  const checkpointTwo = await api.createTransparencyCheckpoint(
    spec.logId,
    {
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
    },
    apiToken,
  );
  const checkpointTwoArtifactUrn = requireStringField(checkpointTwo, 'checkpoint_artifact_urn');

  const leafTwoAlt = leafHash(spec.entryTwoAltLabel);
  const rootTwoAlt = `base64:${nodeHash(leafOne, leafTwoAlt).toString('base64')}`;
  const checkpointBodyTwoAlt = checkpointBody(spec.logId, 2, rootTwoAlt);
  const checkpointSigTwoAlt = encodeSignature(checkpointBodyTwoAlt, checkpointKey);
  const checkpointTwoAltNote = signedCheckpointNote(checkpointBodyTwoAlt, [
    { signer: spec.logId, detachedSignature: checkpointSigTwoAlt, keyHintBytes: specKeyHint(spec.logId, checkpointKey) },
  ]);

  await api.createTransparencyObservation(
    spec.logId,
    {
      signed_note: checkpointTwoAltNote,
      observed_from_type: 'peer',
      observed_from_id: 'observer-beta',
      observed_at: spec.observationOccurredAt,
      source_channel: 'https_poll',
      observer_id: 'collector-1',
      observer_type: 'system',
      relay_from_type: 'distributor',
      relay_from_id: 'mirror-a',
      relay_hop_count: 2,
      source_checkpoint_occurred_at: spec.sourceCheckpointOccurredAt,
    },
    apiToken,
  );

  await api.createTransparencyObservation(
    spec.logId,
    {
      signed_note: checkpointTwoNote,
      observed_from_type: 'witness',
      observed_from_id: 'witness-alpha',
      observed_at: spec.witnessAlphaObservationAt,
      source_channel: 'witness_rpc',
      observer_id: 'collector-1',
      observer_type: 'system',
    },
    apiToken,
  );

  await api.createTransparencyObservation(
    spec.logId,
    {
      signed_note: checkpointTwoAltNote,
      observed_from_type: 'witness',
      observed_from_id: 'witness-beta',
      observed_at: spec.witnessBetaObservationAt,
      source_channel: 'witness_rpc',
      observer_id: 'collector-2',
      observer_type: 'system',
    },
    apiToken,
  );

  await api.createTransparencyGossipEvent(
    spec.logId,
    {
      from_witness_id: 'witness-alpha',
      to_witness_id: 'witness-beta',
      checkpoint_artifact_urn: checkpointTwoArtifactUrn,
      occurred_at: spec.gossipOccurredAt,
      source_channel: 'witness_rpc',
      relayed_by_id: 'relay-gateway-1',
      relay_hop_count: 1,
      source_checkpoint_occurred_at: spec.sourceCheckpointOccurredAt,
    },
    apiToken,
  );

  return {
    spec,
    rootOne,
    rootTwo,
    checkpointTwoPayloadSha: sha256Hex(Buffer.from(checkpointTwoNote, 'utf8')),
    checkpointTwoAltPayloadSha: sha256Hex(Buffer.from(checkpointTwoAltNote, 'utf8')),
  };
}

async function createTrustedKey(api: RegistryOperatorApiClient, apiToken: string, keyRef: string, owner: string) {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await api.createTrustedPublicKey(
    {
      key_ref: keyRef,
      algorithm: 'ed25519',
      public_key_pem: publicKeyPem,
      owner,
    },
    apiToken,
  );
  return pair.privateKey;
}

function requireStringField(value: Record<string, unknown>, key: string) {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`Expected transparency sample graph response to include string field ${key}.`);
  }
  return raw;
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

/**
 * Spec note-key hint (bigendian32(SHA256(origin + "\n" + 0x01||pubkey))[:4]).
 * The registry's checkpoint seam enforces it for Ed25519 trusted keys, so
 * seeded signed notes must bind to the log's key identity.
 */
function specKeyHint(origin: string, privateKey: KeyObject): number[] {
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const keyData = Buffer.concat([Buffer.from([0x01]), publicDer.subarray(publicDer.length - 32)]);
  return [...createHash('sha256').update(origin).update('\n').update(keyData).digest().subarray(0, 4)];
}

function sha256Hex(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
