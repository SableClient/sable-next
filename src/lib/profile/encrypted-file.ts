import { uint8ArrayToBase64 } from 'uint8array-extras';

import { downscaledImage } from '#lib/ui/downscale-image.js';

const AVATAR_EDGE = 256;
const COUNTER_BITS = 64;

export interface EncryptedFile {
  url: string;
  v: string;
  iv: string;
  hashes: Record<string, string>;
  key: Record<string, unknown>;
}

function base64(bytes: Uint8Array): string {
  return uint8ArrayToBase64(bytes).replace(/=+$/, '');
}

export async function encryptAttachment(
  bytes: Uint8Array<ArrayBuffer>
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; file: Omit<EncryptedFile, 'url'> }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv, length: COUNTER_BITS }, key, bytes)
  );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext));
  return {
    ciphertext,
    file: {
      v: 'v2',
      iv: base64(iv),
      hashes: { sha256: base64(hash) },
      key: { ...(await crypto.subtle.exportKey('jwk', key)) },
    },
  };
}

export function downscaledAvatar(file: Blob): Promise<Blob> {
  return downscaledImage(file, AVATAR_EDGE);
}
