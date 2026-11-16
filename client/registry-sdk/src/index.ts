export { RegistryClient, RegistryClientError } from './client.js';
export type { RegistryClientOptions } from './client.js';
export {
  rfc6962LeafHash,
  sha256Hex,
  verifyDetachedSignature,
  verifyEnvelopeSignatures,
  verifyProvenanceSignature,
  verifyRfc6962InclusionProof,
} from './verify.js';
export type {
  DetachedSignatureCheck,
  EnvelopeVerificationResult,
  ProvenanceSignatureCheck,
  ProvenanceSignatureVerdict,
} from './verify.js';
export type { paths, components } from './generated/api.js';
