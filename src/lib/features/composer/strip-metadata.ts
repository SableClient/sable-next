type Bytes = Uint8Array<ArrayBuffer>;

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
const JPEG_DROPPED_MARKERS = new Set([0xe1, 0xed, 0xfe]);
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

export async function stripMetadata(file: File): Promise<File> {
  if (!file.type.startsWith('image/') && !/\.(heic|heif|avif)$/i.test(file.name)) return file;
  try {
    const stripped = stripBytes(new Uint8Array(await file.arrayBuffer()));
    if (!stripped) return file;
    return new File([stripped], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

export function stripBytes(bytes: Bytes): Bytes | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
  if (ascii(bytes, 0, 8) === PNG_SIGNATURE) return stripPng(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return stripWebp(bytes);
  if (ascii(bytes, 4, 4) === 'ftyp' && HEIF_BRANDS.has(ascii(bytes, 8, 4))) return stripHeif(bytes);
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

function stripJpeg(bytes: Bytes): Bytes | null {
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
    if (marker === 0xe1 && ascii(bytes, position + 4, 6) === 'Exif\0\0') {
      orientation = exifOrientation(bytes.subarray(position + 10, end));
    }
    if (!JPEG_DROPPED_MARKERS.has(marker)) parts.push(bytes.subarray(position, end));
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
  view.setUint16(20, 0x0112);
  view.setUint16(22, 3);
  view.setUint32(24, 1);
  view.setUint16(28, orientation);
  return segment;
}

function exifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49;
  const view = viewOf(tiff);
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return 1;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return 1;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return 1;
}

function stripPng(bytes: Bytes): Bytes | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = viewOf(bytes);
  let position = 8;
  while (position + 12 <= bytes.length) {
    const end = position + 12 + view.getUint32(position);
    if (end > bytes.length) return null;
    if (!PNG_METADATA_CHUNKS.has(ascii(bytes, position + 4, 4))) {
      parts.push(bytes.subarray(position, end));
    }
    position = end;
  }
  return position === bytes.length ? concat(parts) : null;
}

function stripWebp(bytes: Bytes): Bytes | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 12)];
  const view = viewOf(bytes);
  let position = 12;
  while (position + 8 <= bytes.length) {
    const size = view.getUint32(position + 4, true);
    const end = position + 8 + size + (size & 1);
    if (end > bytes.length) return null;
    const type = ascii(bytes, position, 4);
    if (!WEBP_METADATA_CHUNKS.has(type)) {
      const chunk = bytes.slice(position, end);
      if (type === 'VP8X') chunk[8] &= ~0x0c;
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

function metadataItems(bytes: Uint8Array, iinf: Box): Set<number> {
  const view = viewOf(bytes);
  const items = new Set<number>();
  const entries = view.getUint8(iinf.body) === 0 ? 2 : 4;
  for (const infe of boxes(bytes, iinf.body + 4 + entries, iinf.end)) {
    const version = view.getUint8(infe.body);
    if (infe.type !== 'infe' || version < 2) continue;
    const idSize = version === 2 ? 2 : 4;
    const id = idSize === 2 ? view.getUint16(infe.body + 4) : view.getUint32(infe.body + 4);
    const typeAt = infe.body + 4 + idSize + 2;
    const type = ascii(bytes, typeAt, 4);
    const name = cString(bytes, typeAt + 4, infe.end);
    if (
      type === 'Exif' ||
      (type === 'mime' && cString(bytes, name.next, infe.end).text === XMP_CONTENT_TYPE)
    ) {
      items.add(id);
    }
  }
  return items;
}

function stripHeif(bytes: Bytes): Bytes | null {
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
      if (targets.has(id) && fromFile && start + length <= out.length)
        out.fill(0, start, start + length);
    }
  }
  return out;
}
