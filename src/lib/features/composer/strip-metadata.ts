import type { ImageMetadata } from '#lib/settings/preferences.svelte.js';

type Bytes = Uint8Array<ArrayBuffer>;
type Scope = Exclude<ImageMetadata, 'keep'>;

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';
const PNG_TEXT_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe]);
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
  'avif',
]);
const XMP_CONTENT_TYPE = 'application/rdf+xml';
const GPS_IFD_TAG = 0x8825;
const ORIENTATION_TAG = 0x0112;
const TIFF_TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

export const canStrip = (file: File): boolean =>
  file.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(file.name);

export async function stripMetadata(file: File, mode: ImageMetadata): Promise<File> {
  if (mode === 'keep' || !canStrip(file)) return file;
  try {
    const stripped = stripBytes(new Uint8Array(await file.arrayBuffer()), mode);
    if (!stripped) return file;
    return new File([stripped], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

export function stripBytes(bytes: Bytes, scope: Scope): Bytes | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes, scope);
  if (ascii(bytes, 0, 8) === PNG_SIGNATURE) return stripPng(bytes, scope);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return stripWebp(bytes, scope);
  if (ascii(bytes, 4, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 4))) {
    return stripHeif(bytes, scope);
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concat(parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const mentionsLocation = (bytes: Uint8Array): boolean =>
  ascii(bytes, 0, bytes.length).includes('GPS');

function tiffEntries(
  tiff: Uint8Array,
  ifd: number
): { view: DataView; little: boolean; at: number[] } {
  const view = viewOf(tiff);
  const little = tiff[0] === 0x49;
  const at: number[] = [];
  if (ifd + 2 <= tiff.length) {
    const count = view.getUint16(ifd, little);
    for (let index = 0; index < count && ifd + 2 + (index + 1) * 12 <= tiff.length; index += 1) {
      at.push(ifd + 2 + index * 12);
    }
  }
  return { view, little, at };
}

function tiffTag(
  tiff: Uint8Array,
  tag: number
): { view: DataView; little: boolean; entry: number } | null {
  if (tiff.length < 8) return null;
  const { view, little, at } = tiffEntries(tiff, viewOf(tiff).getUint32(4, tiff[0] === 0x49));
  const entry = at.find((position) => view.getUint16(position, little) === tag);
  return entry === undefined ? null : { view, little, entry };
}

function exifOrientation(tiff: Uint8Array): number {
  const found = tiffTag(tiff, ORIENTATION_TAG);
  return found ? found.view.getUint16(found.entry + 8, found.little) : 1;
}

function clearGps(tiff: Uint8Array): void {
  const found = tiffTag(tiff, GPS_IFD_TAG);
  if (!found) return;
  const ifd = found.view.getUint32(found.entry + 8, found.little);
  const gps = tiffEntries(tiff, ifd);
  for (const entry of gps.at) {
    const type = gps.view.getUint16(entry + 2, gps.little);
    const size = (TIFF_TYPE_SIZES[type] ?? 1) * gps.view.getUint32(entry + 4, gps.little);
    const value = gps.view.getUint32(entry + 8, gps.little);
    if (size > 4 && value + size <= tiff.length) tiff.fill(0, value, value + size);
  }
  tiff.fill(0, ifd, ifd + 2 + gps.at.length * 12);
}

function stripJpeg(bytes: Bytes, scope: Scope): Bytes | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let orientation = 1;
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) return null;
    const marker = bytes[position + 1];
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.subarray(position));
      if (orientation > 1) parts.splice(1, 0, orientationSegment(orientation));
      return concat(parts);
    }
    const end = position + 2 + viewOf(bytes).getUint16(position + 2);
    if (end < position + 4 || end > bytes.length) return null;
    const segment = bytes.slice(position, end);
    const isExif = marker === 0xe1 && ascii(segment, 4, 6) === 'Exif\0\0';
    if (isExif) orientation = exifOrientation(segment.subarray(10));
    if (scope === 'all') {
      if (!JPEG_METADATA_MARKERS.has(marker)) parts.push(segment);
    } else if (isExif) {
      clearGps(segment.subarray(10));
      parts.push(segment);
    } else if (marker !== 0xe1 || !mentionsLocation(segment)) {
      parts.push(segment);
    }
    position = end;
  }
  return null;
}

function orientationSegment(orientation: number): Uint8Array {
  const segment = new Uint8Array(36);
  const view = new DataView(segment.buffer);
  view.setUint16(0, 0xffe1);
  view.setUint16(2, 34);
  segment.set([0x45, 0x78, 0x69, 0x66], 4);
  segment.set([0x4d, 0x4d], 10);
  view.setUint16(12, 0x2a);
  view.setUint32(14, 8);
  view.setUint16(18, 1);
  view.setUint16(20, ORIENTATION_TAG);
  view.setUint16(22, 3);
  view.setUint32(24, 1);
  view.setUint16(28, orientation);
  return segment;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function stripPng(bytes: Bytes, scope: Scope): Bytes | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = viewOf(bytes);
  let position = 8;
  while (position + 12 <= bytes.length) {
    const end = position + 12 + view.getUint32(position);
    if (end > bytes.length) return null;
    const type = ascii(bytes, position + 4, 4);
    const chunk = bytes.slice(position, end);
    if (scope === 'all') {
      if (!PNG_TEXT_CHUNKS.has(type)) parts.push(chunk);
    } else if (type === 'eXIf') {
      clearGps(chunk.subarray(8, chunk.length - 4));
      viewOf(chunk).setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
      parts.push(chunk);
    } else if (type !== 'iTXt' || !mentionsLocation(chunk)) {
      parts.push(chunk);
    }
    position = end;
  }
  return position === bytes.length ? concat(parts) : null;
}

function stripWebp(bytes: Bytes, scope: Scope): Bytes | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 12)];
  const view = viewOf(bytes);
  let position = 12;
  while (position + 8 <= bytes.length) {
    const size = view.getUint32(position + 4, true);
    const end = position + 8 + size + (size & 1);
    if (end > bytes.length) return null;
    const type = ascii(bytes, position, 4);
    const chunk = bytes.slice(position, end);
    if (scope === 'all') {
      if (!WEBP_METADATA_CHUNKS.has(type)) parts.push(chunk);
      if (type === 'VP8X') chunk[8] &= ~0x0c;
    } else if (type === 'EXIF') {
      const prefix = ascii(chunk, 8, 6) === 'Exif\0\0' ? 6 : 0;
      clearGps(chunk.subarray(8 + prefix, 8 + size));
      parts.push(chunk);
    } else if (type !== 'XMP ' || !mentionsLocation(chunk)) {
      parts.push(chunk);
    }
    position = end;
  }
  if (position !== bytes.length) return null;
  const out = concat(parts);
  viewOf(out).setUint32(4, out.length - 8, true);
  return out;
}

interface Box {
  type: string;
  body: number;
  end: number;
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = viewOf(bytes);
  const found: Box[] = [];
  let position = start;
  while (position + 8 <= end) {
    let size = view.getUint32(position);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(position + 8));
      header = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < header || position + size > end) return found;
    found.push({
      type: ascii(bytes, position + 4, 4),
      body: position + header,
      end: position + size,
    });
    position += size;
  }
  return found;
}

function cString(bytes: Uint8Array, start: number, end: number): { text: string; next: number } {
  let stop = start;
  while (stop < end && bytes[stop] !== 0) stop += 1;
  return { text: ascii(bytes, start, stop - start), next: stop + 1 };
}

function metadataItems(bytes: Uint8Array, iinf: Box): Map<number, 'exif' | 'xmp'> {
  const view = viewOf(bytes);
  const items = new Map<number, 'exif' | 'xmp'>();
  const entries = view.getUint8(iinf.body) === 0 ? 2 : 4;
  for (const infe of boxes(bytes, iinf.body + 4 + entries, iinf.end)) {
    const version = view.getUint8(infe.body);
    if (infe.type !== 'infe' || version < 2) continue;
    const idSize = version === 2 ? 2 : 4;
    const id = idSize === 2 ? view.getUint16(infe.body + 4) : view.getUint32(infe.body + 4);
    const typeAt = infe.body + 4 + idSize + 2;
    const type = ascii(bytes, typeAt, 4);
    const name = cString(bytes, typeAt + 4, infe.end);
    if (type === 'Exif') items.set(id, 'exif');
    else if (type === 'mime' && cString(bytes, name.next, infe.end).text === XMP_CONTENT_TYPE) {
      items.set(id, 'xmp');
    }
  }
  return items;
}

function stripHeif(bytes: Bytes, scope: Scope): Bytes | null {
  const meta = boxes(bytes, 0, bytes.length).find((box) => box.type === 'meta');
  if (!meta) return null;
  const inner = boxes(bytes, meta.body + 4, meta.end);
  const iinf = inner.find((box) => box.type === 'iinf');
  const iloc = inner.find((box) => box.type === 'iloc');
  if (!iinf || !iloc) return null;

  const view = viewOf(bytes);
  const targets = metadataItems(bytes, iinf);
  const version = view.getUint8(iloc.body);
  const offsetSize = view.getUint8(iloc.body + 4) >> 4;
  const lengthSize = view.getUint8(iloc.body + 4) & 0xf;
  const baseSize = view.getUint8(iloc.body + 5) >> 4;
  const indexSize = version > 0 ? view.getUint8(iloc.body + 5) & 0xf : 0;
  const read = (at: number, size: number) =>
    size === 0 ? 0 : size === 4 ? view.getUint32(at) : Number(view.getBigUint64(at));

  const out = bytes.slice();
  let at = iloc.body + 6;
  const count = version < 2 ? view.getUint16(at) : view.getUint32(at);
  at += version < 2 ? 2 : 4;
  for (let item = 0; item < count; item += 1) {
    const id = version < 2 ? view.getUint16(at) : view.getUint32(at);
    at += version < 2 ? 2 : 4;
    const fromFile = version === 0 || (view.getUint16(at) & 0xf) === 0;
    at += version > 0 ? 2 : 0;
    at += 2;
    const base = read(at, baseSize);
    at += baseSize;
    const extents = view.getUint16(at);
    at += 2;
    for (let extent = 0; extent < extents; extent += 1) {
      at += indexSize;
      const offset = read(at, offsetSize);
      at += offsetSize;
      const length = read(at, lengthSize);
      at += lengthSize;
      const start = base + offset;
      const kind = targets.get(id);
      if (!kind || !fromFile || start + length > out.length) continue;
      const data = out.subarray(start, start + length);
      if (scope === 'all' || (kind === 'xmp' && mentionsLocation(data))) data.fill(0);
      else if (kind === 'exif' && length > 4) {
        clearGps(data.subarray(4 + viewOf(data).getUint32(0)));
      }
    }
  }
  return out;
}
