import { describe, expect, test } from 'vitest';

import {
  isExpectedCoreFailure,
  isReportableCoreWarning,
  wasmErrorFingerprint,
  wasmErrorTitle,
  wasmLogLevel,
} from './wasm-log';

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

describe('isReportableCoreWarning', () => {
  test('reports the warnings that explain a failed decryption', () => {
    for (const line of [
      'WARN sable_core::utd: unable to decrypt a message reported=true cause=Unknown',
      'WARN sable_core::calls::runtime: no call media key has arrived reported=true',
      'WARN matrix_sdk_crypto::session_manager::sessions: Failed to claim one-time keys',
      'WARN sync_once{conn_id="encryption"}:receive_sync_changes: matrix_sdk_crypto::olm::account: Failed to decrypt a non-pre-key message with all available sessions',
    ]) {
      expect(isReportableCoreWarning(line)).toBe(true);
    }
  });

  test('ignores other warnings and the same text at a lower level', () => {
    expect(isReportableCoreWarning('WARN sable_core: slow call')).toBe(false);
    expect(isReportableCoreWarning('WARN sable_core::utd: unable to decrypt a message')).toBe(
      false
    );
    expect(isReportableCoreWarning('WARN matrix_sdk_crypto::machine: careful')).toBe(false);
    expect(
      isReportableCoreWarning('INFO sable_core::utd: unable to decrypt a message reported=true')
    ).toBe(false);
  });

  test('keeps the marker out of the title', () => {
    expect(
      wasmErrorTitle(
        'WARN sable_core::utd: unable to decrypt a message reported=true cause=Unknown'
      )
    ).toBe('sable_core::utd: unable to decrypt a message cause=Unknown');
  });
});

describe('isExpectedCoreFailure', () => {
  test('recognizes a latest event update for a room the client dropped', () => {
    expect(
      isExpectedCoreFailure(
        'ERROR matrix_sdk::latest_events::room_latest_events: Room is unknown room=WeakRoom { client: WeakClient { client: (Weak) }, room_id: "!a:b.org" }'
      )
    ).toBe(true);
  });

  test('recognizes a sync request that never reached the server', () => {
    expect(
      isExpectedCoreFailure(
        'ERROR matrix_sdk_ui::sync_service: Error while processing room list: Some( RoomList( SlidingSync( Http( Reqwest( reqwest::Error { kind: Request, source: "JsValue(TypeError: Failed to fetch)" } ) ) ) ) )'
      )
    ).toBe(true);
  });

  test('recognizes a server error and a rejected refresh token', () => {
    expect(
      isExpectedCoreFailure('ERROR sync: MatrixError( Error { status_code: 502, body: NotJson')
    ).toBe(true);
    expect(isExpectedCoreFailure('ERROR sync: ServerResponse( error: invalid_grant )')).toBe(true);
  });

  test('recognizes native connection failures, rate limits and unavailable servers', () => {
    for (const line of [
      'ERROR sable_core::errors: error sending request for url (https://hs.example/_matrix/client/v3/room_keys/version) log_id="e3"',
      'ERROR sable_core::errors: error sending request log_id="e1" context="sealed_account_data"',
      'ERROR sync: Http( Reqwest( reqwest::Error { kind: Request, source: hyper_util::client::legacy::Error(Connect, ConnectError("tcp connect error", 1.2.3.4:443)) } ) )',
      'ERROR sync: MatrixError( Error { status_code: 429, body: Standard( StandardErrorBody { kind: Unknown } ) } )',
      'ERROR sable_core::errors: the server returned an error: [503] <non-json bytes> log_id="e1" context="room_members"',
      'ERROR sable_core::errors: the server returned an error: [400 / M_UNKNOWN] Failed to return /publicRooms: tcp connect error context="public_rooms"',
      'ERROR sable_core::errors: The store is closed log_id="e15" context="paginate"',
      'ERROR sending_task{}:preshare_room_key{}: matrix_sdk_crypto::session_manager::sessions: Tried to create new Olm sessions, but the signed one-time key was missing for some devices',
    ]) {
      expect(isExpectedCoreFailure(line)).toBe(true);
    }
  });

  test('keeps client errors reportable', () => {
    expect(
      isExpectedCoreFailure(
        'ERROR sable_core::errors: the server returned an error: [400 / M_BAD_JSON] JSON integer out of range context="send_state_event"'
      )
    ).toBe(false);
  });

  test('keeps a local failure reportable', () => {
    expect(isExpectedCoreFailure('ERROR sable_core::errors: wrong room state context="x"')).toBe(
      false
    );
  });
});
