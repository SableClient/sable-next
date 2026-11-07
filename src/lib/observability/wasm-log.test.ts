import { describe, expect, test } from 'vitest';

import { readCoreLine, wasmErrorFingerprint, wasmErrorTitle, wasmLogLevel } from './wasm-log';

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

  test('keeps a multi-line pretty-printed error on one line', () => {
    const title = wasmErrorTitle(
      'ERROR matrix_sdk_ui::sync_service: Error while processing room list: Some(\n    Http(\n        Timeout,\n    ),\n)'
    );
    expect(title).toBe(
      'matrix_sdk_ui::sync_service: Error while processing room list: Some( Http( Timeout, ), )'
    );
  });

  test('drops the span chain so the message and its fields fit', () => {
    const title = wasmErrorTitle(
      'WARN next_sync_with_lock:sync_once{conn_id="encryption" timeout=30000}:handle_response:receive_to_device_event{sender="@a:b.org"}: matrix_sdk_crypto::olm::account: Failed to decrypt a non-pre-key message with all available sessions errors_by_olm_session=[("Xc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE", Decryption(InvalidMAC(MacError)))]'
    );
    expect(title).toBe(
      'matrix_sdk_crypto::olm::account: Failed to decrypt a non-pre-key message with all available sessions errors_by_olm_session=[("[KEY]", Decryption(InvalidMAC(MacError)))]'
    );
  });
});

describe('wasmErrorTitle on a fetch failure', () => {
  test('drops the JavaScript stack so a build hash cannot split the issue', () => {
    const line = (hash: string) =>
      `ERROR matrix_sdk_ui::sync_service: Reqwest( reqwest::Error { kind: Request, source: "JsValue(TypeError: Failed to fetch\\n at https://app/core.worker-${hash}.js:2:4600)", } )`;
    expect(wasmErrorFingerprint(line('AAA'))).toBe(wasmErrorFingerprint(line('BBB')));
    expect(wasmErrorTitle(line('AAA'))).not.toContain('JsValue');
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

describe('readCoreLine', () => {
  test('reads the mark the core puts on a line it reports', () => {
    expect(readCoreLine('\u001eERROR sable_core: boom')).toEqual({
      text: 'ERROR sable_core: boom',
      reported: true,
    });
  });

  test('leaves any other line alone', () => {
    expect(readCoreLine('ERROR matrix_sdk: boom')).toEqual({
      text: 'ERROR matrix_sdk: boom',
      reported: false,
    });
  });
});

describe('wasmErrorTitle on a reported warning', () => {
  test('keeps the marker field out of the title', () => {
    expect(
      wasmErrorTitle(
        'WARN sable_core::utd: unable to decrypt a message reported=true cause=Unknown'
      )
    ).toBe('sable_core::utd: unable to decrypt a message cause=Unknown');
  });
});
