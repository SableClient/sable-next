export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const UTF8_FLAG = 0x800;
const STORED = 0;
const DOS_EPOCH_DATE = 33;
const MAX_COMMENT = 0xffff;

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table !== null) return table;

  const built = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    built[index] = value >>> 0;
  }
  table = built;
  return built;
}

function crc32(bytes: Uint8Array): number {
  const lookup = crcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (lookup[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function writeZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => ({
    name: encoder.encode(entry.name),
    bytes: entry.bytes,
    crc: crc32(entry.bytes),
  }));

  const localSize = prepared.reduce(
    (total, entry) => total + LOCAL_HEADER + entry.name.length + entry.bytes.length,
    0
  );
  const centralSize = prepared.reduce(
    (total, entry) => total + CENTRAL_HEADER + entry.name.length,
    0
  );

  const out = new Uint8Array(localSize + centralSize + END_RECORD);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;

  for (const entry of prepared) {
    offsets.push(at);
    view.setUint32(at, LOCAL_SIGNATURE, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, UTF8_FLAG, true);
    view.setUint16(at + 8, STORED, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, DOS_EPOCH_DATE, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.bytes.length, true);
    view.setUint32(at + 22, entry.bytes.length, true);
    view.setUint16(at + 26, entry.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(entry.name, at + LOCAL_HEADER);
    out.set(entry.bytes, at + LOCAL_HEADER + entry.name.length);
    at += LOCAL_HEADER + entry.name.length + entry.bytes.length;
  }

  const centralStart = at;
  for (const [index, entry] of prepared.entries()) {
    view.setUint32(at, CENTRAL_SIGNATURE, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, UTF8_FLAG, true);
    view.setUint16(at + 10, STORED, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, DOS_EPOCH_DATE, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.bytes.length, true);
    view.setUint32(at + 24, entry.bytes.length, true);
    view.setUint16(at + 28, entry.name.length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0, true);
    view.setUint32(at + 42, offsets[index] ?? 0, true);
    out.set(entry.name, at + CENTRAL_HEADER);
    at += CENTRAL_HEADER + entry.name.length;
  }

  view.setUint32(at, END_SIGNATURE, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true);

  return out;
}

function endOfCentralDirectory(view: DataView, length: number): number {
  const earliest = Math.max(0, length - END_RECORD - MAX_COMMENT);
  for (let at = length - END_RECORD; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === END_SIGNATURE) return at;
  }
  throw new Error('Not a zip archive');
}

export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOfCentralDirectory(view, bytes.byteLength);
  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();
  const found = new Map<string, Uint8Array>();
  let at = view.getUint32(end + 16, true);

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new Error('Damaged zip directory');

    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(
      bytes.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength)
    );
    at += CENTRAL_HEADER + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (method !== STORED) throw new Error(`${name} is compressed`);
    if (view.getUint32(local, true) !== LOCAL_SIGNATURE) throw new Error('Damaged zip entry');

    const start =
      local + LOCAL_HEADER + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} is corrupt`);

    found.set(name, data);
  }

  return found;
}
