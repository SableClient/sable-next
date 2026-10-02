import { expect, test } from 'vitest';

import { encryptAttachment, parseEncryptedFile } from './encrypted-file';

function unbase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

test('the ciphertext decrypts with the published key and matches its hash', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const { ciphertext, file } = await encryptAttachment(bytes);

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext));
  expect(btoa(String.fromCharCode(...hash)).replace(/=+$/, '')).toBe(file.hashes.sha256);

  const key = await crypto.subtle.importKey('jwk', file.key as JsonWebKey, 'AES-CTR', false, [
    'decrypt',
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: unbase64(file.iv), length: 64 },
    key,
    ciphertext
  );
  expect([...new Uint8Array(plain)]).toEqual([...bytes]);
  expect(unbase64(file.iv).subarray(8)).toEqual(new Uint8Array(8));
});

test('an object missing a required property is not an encrypted file', async () => {
  const { file } = await encryptAttachment(new Uint8Array(1));
  expect(parseEncryptedFile({ ...file, url: 'mxc://example.org/a' })).not.toBeNull();
  expect(parseEncryptedFile({ ...file })).toBeNull();
  expect(parseEncryptedFile({ ...file, url: 'mxc://example.org/a', iv: undefined })).toBeNull();
});
