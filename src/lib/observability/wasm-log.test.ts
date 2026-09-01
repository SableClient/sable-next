import { describe, expect, test } from 'vitest';

import { wasmErrorFingerprint, wasmErrorTitle, wasmLogLevel } from './wasm-log';

const REMOVE_7 =
  'ERROR room_updates_task{room_id="!a:b.org"}:remove_events: matrix_sdk: failed to remove duplicated events: The item index is invalid: `7`';
const REMOVE_29 =
  'ERROR room_updates_task{room_id="!c:d.org"}:remove_events: matrix_sdk: failed to remove duplicated events: The item index is invalid: `29`';

describe('wasmLogLevel', () => {
  test('reads a level written without a leading timestamp', () => {
    expect(wasmLogLevel('ERROR sable_core: boom')).toBe('error');
    expect(wasmLogLevel('WARN sable_core: careful')).toBe('warn');
    expect(wasmLogLevel('INFO sable_core: hello')).toBe('info');
    expect(wasmLogLevel('DEBUG sable_core: noise')).toBe('info');
  });

  test('does not read a level out of the message', () => {
    expect(wasmLogLevel('INFO sable_core: an ERROR was handled')).toBe('info');
  });
});

describe('wasmErrorTitle', () => {
  test('drops the level and scrubs identifiers', () => {
    const title = wasmErrorTitle('ERROR sable_core: no event $abcdefghijkl for @alice:example.org');
    expect(title.startsWith('sable_core:')).toBe(true);
    expect(title).not.toContain('$abcdefghijkl');
    expect(title).not.toContain('@alice:example.org');
  });
});

describe('wasmErrorFingerprint', () => {
  test('groups the same failure at different indices and rooms', () => {
    expect(wasmErrorFingerprint(REMOVE_7)).toBe(wasmErrorFingerprint(REMOVE_29));
  });

  test('keeps unrelated failures apart', () => {
    expect(wasmErrorFingerprint(REMOVE_7)).not.toBe(
      wasmErrorFingerprint('ERROR sable_core: Event not found in timeline')
    );
  });
});
