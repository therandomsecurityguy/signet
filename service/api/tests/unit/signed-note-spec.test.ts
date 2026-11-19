import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  NoteVerifierKeyError,
  noteKeyDataFromPem,
  noteKeyHashBytes,
  parseNoteVerifierKey,
  parseSignedNote,
  verifySignedNote,
} from '../../../registry/application/services/transparency-notes.js';

// Shared oracle with the Go side: the same file is verified by
// service/tessera-runtime/note_fixture_test.go with the real
// golang.org/x/mod/sumdb/note implementation.
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../tessera-runtime/testdata/signed-notes/spec-note-v1.json', import.meta.url),
    'utf8',
  ),
) as {
  name: string;
  tree_size: number;
  root_hash_hex: string;
  seed_hex: string;
  key_hash_hex: string;
  private_key: string;
  verifier_key: string;
  note_body: string;
  signed_note: string;
};

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Spec key strings are cut on the FIRST separators only — the base64 key
 * data may itself contain '+' (the spec forbids '+' in names for exactly
 * this reason).
 */
function splitNoteKey(key: string): { name: string; hash: string; keyData: Buffer } {
  if (key.startsWith('PRIVATE+KEY+')) {
    const parts = key.split('+');
    return { name: parts[2] ?? '', hash: parts[3] ?? '', keyData: Buffer.from(parts.slice(4).join('+'), 'base64') };
  }
  const parts = key.split('+');
  return { name: parts[0] ?? '', hash: parts[1] ?? '', keyData: Buffer.from(parts.slice(2).join('+'), 'base64') };
}

function fixturePrivateKey() {
  const seed = Buffer.from(fixture.seed_hex, 'hex');
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

describe('transparency-dev signed-note compatibility', () => {
  it('verifies the shared Go fixture with the spec verifier key', () => {
    const outcome = verifySignedNote({ envelope: fixture.signed_note, note_verifier_key: fixture.verifier_key });
    expect(outcome.verified).toBe(true);
    expect(outcome.note).toBe(fixture.note_body);
    expect(outcome.verifier).toEqual({ name: fixture.name, key_hash_hex: fixture.key_hash_hex });

    const parsed = parseSignedNote(fixture.signed_note);
    expect(parsed?.note).toBe(fixture.note_body);
    expect(parsed?.signatures[0]?.name).toBe(fixture.name);
    expect(parsed?.signatures[0]?.keyHint.toString('hex')).toBe(fixture.key_hash_hex);
  });

  it('derives the spec key hash and key data from an Ed25519 PEM', () => {
    const publicKeyPem = createPublicKey(fixturePrivateKey()).export({ type: 'spki', format: 'pem' }).toString();
    const keyData = noteKeyDataFromPem(publicKeyPem);
    expect(keyData).not.toBeNull();
    expect(keyData?.length).toBe(33);
    expect(keyData?.[0]).toBe(0x01);
    expect(noteKeyHashBytes(fixture.name, keyData as Buffer).subarray(0, 4).toString('hex')).toBe(fixture.key_hash_hex);

    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(noteKeyDataFromPem(ec.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBeNull();
    expect(noteKeyDataFromPem('not a pem')).toBeNull();
  });

  it('reproduces the Go signature bytes from the fixture signer key', () => {
    const { keyData } = splitNoteKey(fixture.private_key);
    const privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, keyData.subarray(1)]),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = signBytes(null, Buffer.from(fixture.note_body, 'utf8'), privateKey);
    const hint = Buffer.from(fixture.key_hash_hex, 'hex');
    const envelope = `${fixture.note_body}\n\u2014 ${fixture.name} ${Buffer.concat([hint, signature]).toString('base64')}\n`;
    expect(envelope).toBe(fixture.signed_note);
  });

  it('rejects malformed verifier keys with explicit errors', () => {
    const { hash, keyData } = splitNoteKey(fixture.verifier_key);
    const key64 = keyData.toString('base64');
    const algTwoHash = noteKeyHashBytes(fixture.name, Buffer.concat([Buffer.from([0x02]), keyData.subarray(1)]))
      .subarray(0, 4)
      .toString('hex');
    const cases: Array<[string, RegExp]> = [
      ['', /must be <name>\+<hash8hex>\+<base64>/],
      [`${fixture.name}+${hash}`, /must be <name>\+<hash8hex>\+<base64>/],
      [`bad name+${hash}+${key64}`, /name/],
      [`${fixture.name}+${hash.toUpperCase()}+${key64}`, /8 lowercase hex/],
      [`${fixture.name}+${hash.slice(0, 7)}0+${key64}`, /hash does not match/],
      [
        `${fixture.name}+${algTwoHash}+${Buffer.concat([Buffer.from([0x02]), keyData.subarray(1)]).toString('base64')}`,
        /Ed25519/,
      ],
      [`${fixture.name}+${hash}+${key64}=`, /standard base64/],
    ];
    for (const [verifierKey, pattern] of cases) {
      expect(() => parseNoteVerifierKey(verifierKey), verifierKey).toThrow(NoteVerifierKeyError);
      expect(() => parseNoteVerifierKey(verifierKey), verifierKey).toThrow(pattern);
    }
  });

  it('rejects tampered notes and mismatched key selection in spec mode', () => {
    const parsed = parseSignedNote(fixture.signed_note);
    const signature = Buffer.from(parsed?.signatures[0]?.signature as Buffer);
    signature[signature.length - 1] = (signature[signature.length - 1] as number) ^ 0x01;
    const tampered = `${fixture.note_body}\n\u2014 ${fixture.name} ${Buffer.concat([
      Buffer.from(fixture.key_hash_hex, 'hex'),
      signature,
    ]).toString('base64')}\n`;
    expect(tampered).not.toBe(fixture.signed_note);
    const tamperedOutcome = verifySignedNote({ envelope: tampered, note_verifier_key: fixture.verifier_key });
    expect(tamperedOutcome.verified).toBe(false);
    expect(tamperedOutcome.error).toBe('invalid checkpoint signature');

    // A verifier key for a different name selects no signature.
    const { keyData } = splitNoteKey(fixture.verifier_key);
    const otherName = 'some-other-log';
    const otherHash = noteKeyHashBytes(otherName, keyData).subarray(0, 4).toString('hex');
    const otherVerifier = `${otherName}+${otherHash}+${keyData.toString('base64')}`;
    const wrongNameOutcome = verifySignedNote({ envelope: fixture.signed_note, note_verifier_key: otherVerifier });
    expect(wrongNameOutcome.verified).toBe(false);
    expect(wrongNameOutcome.error).toBe('checkpoint note carries no signature for the configured verifier key');

    const malformedOutcome = verifySignedNote({ envelope: 'no separator here', note_verifier_key: fixture.verifier_key });
    expect(malformedOutcome.verified).toBe(false);
    expect(malformedOutcome.error).toBe('malformed checkpoint note');
  });

  it('keeps the legacy SPKI-hint mode working and distinct from spec mode', () => {
    const privateKey = fixturePrivateKey();
    const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const legacyHint = createHash('sha256').update(spkiDer).digest().subarray(0, 4);
    const signature = signBytes(null, Buffer.from(fixture.note_body, 'utf8'), privateKey);
    const legacyEnvelope = `${fixture.note_body}\n\u2014 legacy-log ${Buffer.concat([
      legacyHint,
      signature,
    ]).toString('base64')}\n`;

    const legacyOutcome = verifySignedNote({
      envelope: legacyEnvelope,
      public_key_pem: publicKeyPem,
      key_hint_source: legacyHint,
    });
    expect(legacyOutcome.verified).toBe(true);
    expect(legacyOutcome.note).toBe(fixture.note_body);

    // The same legacy note does not satisfy spec mode (no spec-hint signature).
    const specOutcome = verifySignedNote({ envelope: legacyEnvelope, note_verifier_key: fixture.verifier_key });
    expect(specOutcome.verified).toBe(false);
    expect(specOutcome.error).toBe('checkpoint note carries no signature for the configured verifier key');

    // Legacy mode without a key is a configuration error, not a pass.
    const unconfigured = verifySignedNote({ envelope: legacyEnvelope });
    expect(unconfigured.verified).toBe(false);
    expect(unconfigured.error).toBe('checkpoint verification requires a trusted key');
  });
});
