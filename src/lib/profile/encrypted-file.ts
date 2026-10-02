import { isRecord } from '#lib/guards.js';

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
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
}

export function parseEncryptedFile(value: unknown): EncryptedFile | null {
  if (!isRecord(value)) return null;
  const { url, v, iv, hashes, key } = value;
  if (
    typeof url !== 'string' ||
    !url.startsWith('mxc://') ||
    typeof v !== 'string' ||
    typeof iv !== 'string' ||
    !isRecord(hashes) ||
    typeof hashes.sha256 !== 'string' ||
    !isRecord(key) ||
    typeof key.k !== 'string'
  ) {
    return null;
  }
  return { url, v, iv, hashes: hashes as Record<string, string>, key };
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

export async function downscaledAvatar(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(1, AVATAR_EDGE / Math.max(bitmap.width, bitmap.height));
      if (scale === 1) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve) => {
        canvas.toBlob(
          (blob) => {
            resolve(blob ?? file);
          },
          'image/webp',
          0.9
        );
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}
