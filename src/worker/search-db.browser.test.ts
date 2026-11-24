import { expect, test } from 'vitest';

type Param = null | number | string;

const text = new TextEncoder();
const utf8 = new TextDecoder();

function pack(value: unknown, out: number[]): void {
  if (value === null) out.push(0xc0);
  else if (typeof value === 'boolean') out.push(value ? 0xc3 : 0xc2);
  else if (typeof value === 'number') {
    out.push(0xd3);
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setBigInt64(0, BigInt(value));
    out.push(...new Uint8Array(bytes.buffer));
  } else if (typeof value === 'string') {
    const bytes = text.encode(value);
    out.push(
      0xdb,
      (bytes.length >>> 24) & 255,
      (bytes.length >>> 16) & 255,
      (bytes.length >>> 8) & 255,
      bytes.length & 255
    );
    out.push(...bytes);
  } else if (Array.isArray(value)) {
    out.push(0xdd, 0, 0, (value.length >>> 8) & 255, value.length & 255);
    for (const item of value) pack(item, out);
  } else {
    const entries = Object.entries(value as Record<string, unknown>);
    out.push(0xdf, 0, 0, 0, entries.length);
    for (const [key, item] of entries) {
      pack(key, out);
      pack(item, out);
    }
  }
}

function unpack(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const read = (): unknown => {
    const tag = bytes[at++];
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 256;
    if (tag >= 0xa0 && tag <= 0xbf) return string(tag & 31);
    if (tag >= 0x90 && tag <= 0x9f) return list(tag & 15);
    if (tag >= 0x80 && tag <= 0x8f) return map(tag & 15);
    switch (tag) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xcc:
        return bytes[at++];
      case 0xcd: {
        at += 2;
        return view.getUint16(at - 2);
      }
      case 0xce: {
        at += 4;
        return view.getUint32(at - 4);
      }
      case 0xd0:
        return view.getInt8(at++);
      case 0xd1: {
        at += 2;
        return view.getInt16(at - 2);
      }
      case 0xd2: {
        at += 4;
        return view.getInt32(at - 4);
      }
      case 0xd3: {
        at += 8;
        return Number(view.getBigInt64(at - 8));
      }
      case 0xcf: {
        at += 8;
        return Number(view.getBigUint64(at - 8));
      }
      case 0xcb: {
        at += 8;
        return view.getFloat64(at - 8);
      }
      case 0xd9:
        return string(bytes[at++]);
      case 0xda: {
        at += 2;
        return string(view.getUint16(at - 2));
      }
      case 0xdb: {
        at += 4;
        return string(view.getUint32(at - 4));
      }
      case 0xdc: {
        at += 2;
        return list(view.getUint16(at - 2));
      }
      case 0xdd: {
        at += 4;
        return list(view.getUint32(at - 4));
      }
      case 0xde: {
        at += 2;
        return map(view.getUint16(at - 2));
      }
      default:
        throw new Error(`unsupported msgpack tag ${String(tag)}`);
    }
  };
  const string = (length: number): string => {
    at += length;
    return utf8.decode(bytes.subarray(at - length, at));
  };
  const list = (length: number): unknown[] => Array.from({ length }, read);
  const map = (length: number): Record<string, unknown> => {
    const entries: [string, unknown][] = [];
    for (let i = 0; i < length; i += 1) entries.push([read() as string, read()]);
    return Object.fromEntries(entries);
  };
  return read();
}

function value(param: Param): unknown {
  if (param === null) return 'Null';
  return typeof param === 'number' ? { Integer: param } : { Text: param };
}

class SearchDatabase {
  worker = new Worker(new URL('./search-db.worker.ts', import.meta.url), { type: 'module' });
  port: MessagePort;
  #next = 1;
  #waiting = new Map<number, (rows: unknown[][][]) => void>();

  constructor() {
    const channel = new MessageChannel();
    this.port = channel.port2;
    this.port.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
      const [id, result] = unpack(data) as [number, { Ok?: unknown[][][]; Err?: string }];
      if (result.Err) throw new Error(result.Err);
      this.#waiting.get(id)?.(result.Ok ?? []);
    };
    this.worker.postMessage({ port: channel.port1 }, [channel.port1]);
  }

  batch(database: string, statements: [string, Param[]][]): Promise<unknown[][][]> {
    const id = this.#next++;
    const out: number[] = [];
    pack([id, database, statements.map(([sql, params]) => [sql, params.map(value)]), false], out);
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      const bytes = new Uint8Array(out);
      this.port.postMessage(bytes, [bytes.buffer]);
    });
  }

  stop(): void {
    this.port.close();
    this.worker.terminate();
  }
}

const DATABASE = `search-test-${String(Date.now())}.sqlite3`;

test('a document written through the search worker is found again after the worker restarts', async () => {
  const first = new SearchDatabase();
  await first.batch(DATABASE, [
    [
      'INSERT INTO doc (room_id, event_id, ts, sender, state, attachment, json) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5)',
      ['!room:example.org', '$one', 5, '@alice:example.org', 'x'],
    ],
    ["INSERT INTO fts (rowid, text) VALUES (last_insert_rowid(), 'thai สวัสดี needle')", []],
  ]);
  const [found] = await first.batch(DATABASE, [
    ["SELECT d.event_id FROM fts JOIN doc d ON d.id = fts.rowid WHERE fts MATCH 'needle'", []],
  ]);
  expect(found).toEqual([[{ Text: '$one' }]]);
  first.stop();

  const second = new SearchDatabase();
  const [again] = await second.batch(DATABASE, [
    ["SELECT d.event_id FROM fts JOIN doc d ON d.id = fts.rowid WHERE fts MATCH 'needle'", []],
  ]);
  second.stop();

  expect(again).toEqual([[{ Text: '$one' }]]);
});
