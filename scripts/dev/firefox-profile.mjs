/**
 *   node scripts/dev/firefox-profile.mjs <profile.json[.gz]> [sable_wasm_bg.debug.wasm]
 *
 * Fetch the debug wasm of a deployed build with
 *   sentry api "projects/sable-client/sable-next/files/dsyms/?query=<build id>"
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const [profilePath, debugWasmPath] = process.argv.slice(2);
if (!profilePath) {
  console.error('usage: firefox-profile.mjs <profile.json[.gz]> [debug.wasm]');
  process.exit(2);
}

const raw = readFileSync(profilePath);
const profile = JSON.parse((profilePath.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
const names = debugWasmPath ? wasmNames(readFileSync(debugWasmPath)) : new Map();

const shared = profile.shared;
const strings = shared.stringArray;
const { frame: stackFrame, prefixOffset } = shared.stackTable;
const frames = shared.frameTable;
const funcs = shared.funcTable;
const categories = profile.meta.categories.map((category) => category.name);
const start = profile.meta.profilingStartTime;
const seconds = (profile.meta.profilingEndTime - start) / 1000;

const frameNames = new Map();
function frameName(frame) {
  let name = frameNames.get(frame);
  if (name !== undefined) return name;
  name = strings[funcs.name[frames.func[frame]]];
  const index = /^wasm-function\[(\d+)\]/.exec(name)?.[1];
  if (index !== undefined && names.has(Number(index))) {
    name = names
      .get(Number(index))
      .replace(/::h[0-9a-f]{16}$/, '')
      .replace(/\[[0-9a-f]{12,16}\]/g, '');
  }
  frameNames.set(frame, name);
  return name;
}

function chain(stack) {
  const out = [];
  for (let at = stack; at !== null;) {
    out.push(frameName(stackFrame[at]));
    const offset = prefixOffset[at];
    at = offset === 0 ? null : at - offset;
  }
  return out.reverse();
}

const workers = profile.threads.filter(
  (thread) =>
    thread.name === 'DOM Worker' &&
    String(thread['eTLD+1'] ?? '').includes('sable') &&
    thread.samples.length > 0
);
const core = workers.sort((left, right) => busy(right).length - busy(left).length)[0];
if (!core) {
  console.error('no Sable worker thread in this profile');
  process.exit(1);
}

function busy(thread) {
  return thread.samples.stack.filter(
    (stack) => stack !== null && categories[frames.category[stackFrame[stack]]] !== 'Idle'
  );
}

const tasks = new Map();
const idbTasks = new Map();
let busySamples = 0;
for (const stack of busy(core)) {
  busySamples += 1;
  const path = chain(stack);
  let task = '(other)';
  for (const name of path) {
    const spawned = /executor::sys::spawn::<(.*?)(?:, \(\)>|, core::result)/.exec(name);
    if (spawned) task = spawned[1];
    else if (name.includes('future_to_promise') && name.includes('SableCore')) task = 'rpc call';
  }
  task = task
    .replace(/::\{closure#\d+\}/g, '')
    .replace(/^<|>$/g, '')
    .slice(0, 110);
  tasks.set(task, (tasks.get(task) ?? 0) + 1);
  if (path.some((name) => /indexeddb|IndexedDB|IDB/i.test(name))) {
    idbTasks.set(task, (idbTasks.get(task) ?? 0) + 1);
  }
}

const idbEvents = new Map();
const idbIpc = new Map();
const requests = new Map();
for (const thread of profile.threads) {
  const markers = thread.markers;
  for (let index = 0; index < markers.length; index += 1) {
    const data = markers.data[index];
    if (!data) continue;
    if (thread === core && data.type === 'DOMEvent') {
      idbEvents.set(data.eventType, (idbEvents.get(data.eventType) ?? 0) + 1);
    }
    if (thread === core && data.type === 'IPC' && String(data.messageType).includes('IDB')) {
      idbIpc.set(data.messageType, (idbIpc.get(data.messageType) ?? 0) + 1);
    }
    if (
      data.type === 'Network' &&
      data.status === 'STATUS_STOP' &&
      data.URI?.includes('/_matrix/')
    ) {
      const route = data.URI.replace(/\?.*/, '')
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/\/(rooms|user|profile|presence)\/[^/]+/g, '/$1/:id')
        .replace(/\/(relations|event|context)\/[^/]+/g, '/$1/:id')
        .replace(/\/state\/([^/]+)\/.*/, '/state/$1/:key');
      const entry = requests.get(route) ?? { count: 0, bytes: 0 };
      entry.count += 1;
      entry.bytes += data.count ?? 0;
      requests.set(route, entry);
    }
  }
}

const top = (map, limit) => [...map].sort(([, a], [, b]) => b - a).slice(0, limit);
const percent = (value) => `${((value / busySamples) * 100).toFixed(1)}%`;

console.log(
  `profile ${seconds.toFixed(1)}s, core worker busy ${busySamples} samples (${((busySamples / (seconds * 1000)) * 100).toFixed(1)}% at 1ms)`
);
console.log(
  `\nIndexedDB  transactions ${idbIpc.get('PBackgroundIDBDatabase::Msg_PBackgroundIDBTransactionConstructor') ?? 0}  requests ${idbIpc.get('PBackgroundIDBTransaction::Msg_PBackgroundIDBRequestConstructor') ?? 0}  aborts ${idbIpc.get('PBackgroundIDBTransaction::Msg_Abort') ?? 0}  success events ${idbEvents.get('success') ?? 0}`
);
console.log('\nbusy samples by task');
for (const [task, count] of top(tasks, 20)) {
  console.log(
    `  ${String(count).padStart(6)} ${percent(count).padStart(6)}  idb ${String(idbTasks.get(task) ?? 0).padStart(5)}  ${task}`
  );
}
console.log('\nmatrix requests (count, KB)');
for (const [route, { count, bytes }] of [...requests]
  .sort(([, a], [, b]) => b.count - a.count)
  .slice(0, 20)) {
  console.log(
    `  ${String(count).padStart(5)} ${String(Math.round(bytes / 1024)).padStart(7)}  ${route}`
  );
}

function wasmNames(bytes) {
  const found = new Map();
  let at = 8;
  const leb = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) return result;
    }
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = leb();
    const end = at + size;
    if (id === 0) {
      const length = leb();
      const section = bytes.subarray(at, at + length).toString('utf8');
      at += length;
      if (section === 'name') {
        while (at < end) {
          const kind = bytes[at++];
          const subEnd = leb() + at;
          if (kind === 1) {
            for (let count = leb(); count > 0; count -= 1) {
              const index = leb();
              const nameLength = leb();
              found.set(index, bytes.subarray(at, at + nameLength).toString('utf8'));
              at += nameLength;
            }
          }
          at = subEnd;
        }
      }
    }
    at = end;
  }
  return found;
}
