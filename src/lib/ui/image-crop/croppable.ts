import { imageMime } from '#lib/media-signatures.js';

const SCAN_BYTES = 65_536;

/**
 * Canvas cropping keeps only the first frame of an animation, and Chromium
 * cannot decode SVG to a bitmap, so those upload as they are.
 */
export async function isCroppable(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, SCAN_BYTES).arrayBuffer());
  switch (imageMime(head)) {
    case 'image/gif':
    case 'image/svg+xml':
      return false;
    case 'image/webp':
      return !animatedWebp(head);
    case 'image/png':
      return !animatedPng(head);
    default:
      return true;
  }
}

// RFC 9649: an extended (VP8X) header whose flags byte carries the animation bit.
function animatedWebp(bytes: Uint8Array): boolean {
  return fourcc(bytes, 12) === 'VP8X' && (bytes[20] & 0x02) !== 0;
}

// APNG: an acTL chunk before the first IDAT.
function animatedPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = fourcc(bytes, offset + 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + view.getUint32(offset);
  }
  return false;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}
