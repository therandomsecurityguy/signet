import { bundleToJSON, type Bundle } from '@sigstore/bundle';
import { X509Certificate } from '@sigstore/core';
import { CIContextProvider, FulcioSigner, MessageSignatureBundleBuilder, RekorWitness } from '@sigstore/sign';

const OIDC_ISSUER_OID_V1 = '1.3.6.1.4.1.57264.1.1';
const OIDC_ISSUER_OID_V2 = '1.3.6.1.4.1.57264.1.8';

export type KeylessSignature = {
  bundle: Record<string, unknown>;
  identity: string;
  issuer: string;
};

function oidcIssuerFromCertificate(cert: X509Certificate): string | undefined {
  const v2 = cert.extension(OIDC_ISSUER_OID_V2);
  if (v2) {
    const value = v2.valueObj?.subs?.[0]?.value;
    if (value) return value.toString('ascii');
  }
  const v1 = cert.extension(OIDC_ISSUER_OID_V1);
  return v1 ? v1.value.toString('ascii') : undefined;
}

function readBundleIdentity(bundle: Record<string, unknown>): { identity: string; issuer: string } {
  const material = bundle['verificationMaterial'] as Record<string, unknown> | undefined;
  const chain = material?.['x509CertificateChain'] as
    | { certificates?: Array<{ rawBytes?: string }> }
    | undefined;
  const certificate =
    (material?.['certificate'] as Record<string, unknown> | undefined) ?? chain?.certificates?.[0];
  const rawBytes = certificate?.['rawBytes'];
  if (typeof rawBytes !== 'string') {
    throw new Error('Fulcio bundle does not carry a signing certificate.');
  }
  const cert = X509Certificate.parse(Buffer.from(rawBytes, 'base64'));
  const identity = cert.subjectAltName;
  const issuer = oidcIssuerFromCertificate(cert);
  if (!identity || !issuer) {
    throw new Error('Signing certificate is missing its subject alternative name or OIDC issuer.');
  }
  return { identity, issuer };
}

// Keyless (sigstore) signing for CI: the OIDC identity (ambient in GitHub
// Actions via CIContextProvider, or an explicit token) is exchanged at Fulcio
// for a short-lived certificate, the payload bytes are signed with an
// ephemeral P-256 key, and the sigstore bundle is assembled (serialized JSON,
// the shape the registry verifies). Rekor upload is optional.
export async function buildKeylessBundle(input: {
  data: Buffer;
  oidcToken?: string;
  fulcioBaseURL?: string;
  rekorBaseURL?: string;
}): Promise<KeylessSignature> {
  const identityProvider = input.oidcToken
    ? { getToken: async () => input.oidcToken as string }
    : new CIContextProvider();
  const signer = new FulcioSigner({
    identityProvider,
    ...(input.fulcioBaseURL ? { fulcioBaseURL: input.fulcioBaseURL } : {}),
  });
  const builder = new MessageSignatureBundleBuilder({
    signer,
    witnesses: input.rekorBaseURL ? [new RekorWitness({ rekorBaseURL: input.rekorBaseURL })] : [],
  });
  const bundle = await builder.create({ data: input.data });
  const serialized = bundleToJSON(bundle as Bundle) as unknown as Record<string, unknown>;
  return { bundle: serialized, ...readBundleIdentity(serialized) };
}
