#!/usr/bin/env node
/**
 * Generate or convert an Ed25519 key for the native companion transparency
 * log in the transparency-dev signed-note format (golang.org/x/mod/sumdb/note).
 *
 * Usage:
 *   node scripts/make-tessera-note-key.mjs <log-origin> [--from-pem private.pem]
 *   node scripts/make-tessera-note-key.mjs <log-origin> [--from-pem private.pem] --json
 *
 * Without --from-pem a fresh Ed25519 key is generated. The PEM must be an
 * unencrypted Ed25519 PKCS8 private key (openssl genpkey -algorithm ED25519).
 *
 * Outputs:
 * - the signer string `PRIVATE+KEY+<name>+<hash8hex>+<base64>` — seed it as
 *   the signing key (never commit it; e.g. Secrets Manager key
 *   `tessera-log-note-key`)
 * - the verifier string `<name>+<hash8hex>+<base64>` — public; set it as
 *   `TESSERA_LOG_NOTE_VERIFIER` (Helm: tesseraSidecar.logNoteVerifier)
 *
 * The name must have no spaces or '+' (it is part of the key identity hash).
 */

import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const [name, ...flags] = process.argv.slice(2);
if (!name || name.startsWith('--')) {
  fail('usage: make-tessera-note-key.mjs <log-origin> [--from-pem private.pem] [--json]');
}
if (!/^\S+$/u.test(name) || name.includes('+')) {
  fail('log origin must be non-empty with no spaces or "+" characters');
}

const json = flags.includes('--json');
const pemIndex = flags.indexOf('--from-pem');
let privateKey;
if (pemIndex >= 0) {
  const pemPath = flags[pemIndex + 1];
  if (!pemPath) fail('--from-pem requires a path to an Ed25519 PKCS8 PEM private key');
  try {
    privateKey = createPrivateKey(readFileSync(pemPath, 'utf8'));
  } catch (err) {
    fail(`could not read the PEM private key: ${err instanceof Error ? err.message : err}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail(`the PEM key is ${privateKey.asymmetricKeyType ?? 'unknown'}, not ed25519; the note spec supports Ed25519 only`);
  }
} else {
  privateKey = generateKeyPairSync('ed25519').privateKey;
}

const jwk = privateKey.export({ format: 'jwk' });
if (!jwk.d || !jwk.x) fail('the private key did not export Ed25519 key material');
const seed = Buffer.from(jwk.d, 'base64url');
const publicKey = Buffer.from(jwk.x, 'base64url');
const keyData = Buffer.concat([Buffer.from([0x01]), publicKey]);

const hash = createHash('sha256').update(name).update('\n').update(keyData).digest().subarray(0, 4);
const hashHex = hash.toString('hex');
const signerKey = `PRIVATE+KEY+${name}+${hashHex}+${Buffer.concat([Buffer.from([0x01]), seed]).toString('base64')}`;
const verifierKey = `${name}+${hashHex}+${keyData.toString('base64')}`;

if (json) {
  console.log(JSON.stringify({ name, key_hash_hex: hashHex, signer_key: signerKey, verifier_key: verifierKey }, null, 2));
} else {
  console.log(`name:         ${name}`);
  console.log(`key hash:     ${hashHex} (spec key hash = bigendian32(SHA256(name + "\\n" + 0x01||pubkey)))`);
  console.log('');
  console.log(`signer key (SECRET — seed as tessera-log-note-key):`);
  console.log(signerKey);
  console.log('');
  console.log(`verifier key (PUBLIC — set TESSERA_LOG_NOTE_VERIFIER / tesseraSidecar.logNoteVerifier):`);
  console.log(verifierKey);
}
