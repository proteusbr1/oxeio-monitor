import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseUpdatePublicKey,
  signatureFromFile,
  verifyUpdateSignature,
} from '../src/agent/update-signature';

/**
 * The owner's signature on an agent MSI, the server's side. The OpenSSL
 * fixture is the same one the agent's UpdateSignatureTests uses — server and
 * agent must agree on exactly what `openssl dgst -sha256 -sign` writes.
 */
const OPENSSL_PUBLIC_KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6p7Rdo6T1C/cclg2fBYwTYfABYMu4ttpP79rlhGNLlR4d/Nln2TL0mwxvBO0tn+kbluTEpifo+YWfYwebm1vXQ==';
const OPENSSL_SIGNATURE =
  'MEUCIQDpgh9xqO35yyvLdVjqGytZH7nX3qYZYWKuDuoNs+aLHwIgRMm6nHpsMuNhI7zwTyD2+a5bOXAR1k6lbbgLpXqLspc=';
const OPENSSL_FILE = Buffer.from('pretend this is an MSI\n');

describe('parseUpdatePublicKey', () => {
  it('unset → null (unsigned updates allowed, as before)', () => {
    expect(parseUpdatePublicKey(undefined)).toBeNull();
    expect(parseUpdatePublicKey('  ')).toBeNull();
  });

  it('a set but unreadable key stops the server — never silently off', () => {
    expect(() => parseUpdatePublicKey('not a key')).toThrow(
      /AGENT_UPDATE_PUBLIC_KEY/,
    );
  });
});

describe('verifyUpdateSignature', () => {
  it('accepts what OpenSSL signs', async () => {
    const key = parseUpdatePublicKey(OPENSSL_PUBLIC_KEY)!;
    expect(
      await verifyUpdateSignature(key, OPENSSL_FILE, OPENSSL_SIGNATURE),
    ).toBe(true);
  });

  it('refuses another file', async () => {
    const key = parseUpdatePublicKey(OPENSSL_PUBLIC_KEY)!;
    expect(
      await verifyUpdateSignature(
        key,
        Buffer.from('another MSI'),
        OPENSSL_SIGNATURE,
      ),
    ).toBe(false);
  });

  it('refuses a signature made with another key', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const foreign = sign('sha256', OPENSSL_FILE, privateKey).toString('base64');
    const key = parseUpdatePublicKey(OPENSSL_PUBLIC_KEY)!;
    expect(await verifyUpdateSignature(key, OPENSSL_FILE, foreign)).toBe(false);
  });

  it('streams — the MSI is never read into memory whole', async () => {
    const key = parseUpdatePublicKey(OPENSSL_PUBLIC_KEY)!;
    async function* chunks() {
      yield OPENSSL_FILE.subarray(0, 5);
      yield OPENSSL_FILE.subarray(5);
    }
    expect(await verifyUpdateSignature(key, chunks(), OPENSSL_SIGNATURE)).toBe(
      true,
    );
  });
});

describe('signatureFromFile', () => {
  it('binary DER (what OpenSSL writes) → base64', () => {
    const der = Buffer.from(OPENSSL_SIGNATURE, 'base64');
    expect(signatureFromFile(der)).toBe(OPENSSL_SIGNATURE);
  });

  it('the same already in base64 is kept', () => {
    expect(signatureFromFile(Buffer.from(`${OPENSSL_SIGNATURE}\n`))).toBe(
      OPENSSL_SIGNATURE,
    );
  });

  it('anything else is not a signature', () => {
    expect(signatureFromFile(Buffer.from(''))).toBeNull();
    expect(signatureFromFile(Buffer.from('hello'))).toBeNull();
  });
});
