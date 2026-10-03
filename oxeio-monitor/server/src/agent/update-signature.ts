import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

/**
 * The owner's signature on an agent update — the server's side.
 *
 * The agent refuses an update that is not signed with the owner's key, when
 * the PC has that key (agent: `UpdateSignature.cs`). The server never holds
 * the private key: it only stores the signature the owner made offline
 * (`openssl dgst -sha256 -sign key.pem -out x.msi.sig x.msi`) and passes it
 * on in the update offer.
 *
 * With `AGENT_UPDATE_PUBLIC_KEY` set the server also checks the signature at
 * publish time, for the same reason it recomputes the sha256 there: a wrong
 * one would make every signed PC download the update and throw it away,
 * forever, with nothing on the dashboard to say why.
 */

/** The public key as PEM or as its one-line base64 body; `null` when empty */
export function parseUpdatePublicKey(
  text: string | undefined | null,
): KeyObject | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const body = trimmed
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');

  try {
    return createPublicKey({
      key: Buffer.from(body, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new Error(
      'AGENT_UPDATE_PUBLIC_KEY is not a public key (PEM, or its base64 body on one line)',
    );
  }
}

/**
 * A `.sig` file as OpenSSL writes it (binary DER), or the same in base64 —
 * returned as base64, the form the offer carries. `null` when it is neither.
 */
export function signatureFromFile(content: Buffer): string | null {
  if (content.length === 0) return null;
  // DER ECDSA signatures are a SEQUENCE: 0x30
  if (content[0] === 0x30) return content.toString('base64');

  const text = content.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(text)) return null;
  const decoded = Buffer.from(text, 'base64');
  return decoded.length > 0 && decoded[0] === 0x30 ? text : null;
}

/**
 * Does `signatureBase64` sign these bytes with this key (ECDSA, SHA-256)?
 * ⚠️ Takes a stream, like `hashFile`: an MSI is ~62 MB.
 */
export async function verifyUpdateSignature(
  key: KeyObject,
  data: AsyncIterable<Buffer> | Buffer,
  signatureBase64: string,
): Promise<boolean> {
  const verifier = createVerify('sha256');
  if (Buffer.isBuffer(data)) verifier.update(data);
  else for await (const chunk of data) verifier.update(chunk);
  try {
    return verifier.verify(key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
