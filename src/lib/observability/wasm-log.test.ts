import { describe, expect, test } from 'vitest';

import {
  readCoreLine,
  wasmErrorFingerprint,
  wasmErrorTitle,
  wasmLogFields,
  wasmLogLevel,
} from './wasm-log';

const REMOVE_7 =
  'ERROR room_updates_task{room_id="!a:b.org"}:remove_events: matrix_sdk: failed to remove duplicated events: The item index is invalid: `7`';
const UTD_UNKNOWN =
  'WARN sable_core::utd: unable to decrypt a message reported=true cause=Unknown age="before_this_device" own_identity_trusted=true same_homeserver=true backup=Enabled backup_lookup="imported" account_cross_signed=true device_cross_signed=true megolm_session="c1d4ace413de"';
const UTD_BEFORE_JOIN =
  'WARN sable_core::utd: unable to decrypt a message reported=true cause=SentBeforeWeJoined age="before_this_device" own_identity_trusted=true same_homeserver=false backup=Enabled backup_lookup="not_in_backup" megolm_session="2213949a9c1d" sender_device="0a1b2c3d4e5f"';
const olm = (errors: string) =>
  `WARN receive_to_device_event{sender="@a:b.org"}: matrix_sdk_crypto::olm::account: Failed to decrypt a non-pre-key message with all available sessions errors_by_olm_session=${errors}`;
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

  test('groups undecryptable messages whatever their fields say', () => {
    expect(wasmErrorFingerprint(UTD_UNKNOWN)).toBe(wasmErrorFingerprint(UTD_BEFORE_JOIN));
    expect(wasmErrorFingerprint(UTD_UNKNOWN)).toBe('sable_core::utd: unable to decrypt a message');
  });

  test('groups olm failures whatever sessions failed and how', () => {
    expect(
      wasmErrorFingerprint(
        olm('[("Xc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE", MissingMessageKey(5))]')
      )
    ).toBe(
      wasmErrorFingerprint(
        olm(
          '[("Xc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE", InvalidMAC(MacError)), ("Yc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE", MissingMessageKey(1772))]'
        )
      )
    );
  });
});

describe('wasmLogFields', () => {
  test('splits the fields from the message and unquotes their values', () => {
    expect(wasmLogFields(UTD_BEFORE_JOIN)).toEqual({
      message: 'sable_core::utd: unable to decrypt a message',
      fields: {
        cause: 'SentBeforeWeJoined',
        age: 'before_this_device',
        own_identity_trusted: 'true',
        same_homeserver: 'false',
        backup: 'Enabled',
        backup_lookup: 'not_in_backup',
        megolm_session: '2213949a9c1d',
        sender_device: '0a1b2c3d4e5f',
      },
    });
  });

  test('keeps a value with spaces, brackets and quotes whole', () => {
    expect(
      wasmLogFields(olm('[("Xc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE", InvalidMAC(MacError))]'))
        .fields
    ).toEqual({ errors_by_olm_session: '[("[KEY]", InvalidMAC(MacError))]' });
  });

  test('reads dotted keys and leaves a message without fields alone', () => {
    expect(
      wasmLogFields(
        'ERROR sable_core::errors: the server returned an error: [400 / M_UNKNOWN] failed body.server=Some("example.org") context="public_rooms"'
      )
    ).toEqual({
      message: 'sable_core::errors: the server returned an error: [400 / M_UNKNOWN] failed',
      fields: { 'body.server': 'Some("example.org")', context: 'public_rooms' },
    });
    expect(wasmLogFields(REMOVE_7)).toEqual({ message: wasmErrorTitle(REMOVE_7), fields: {} });
  });

  test('finds the fields after a URL whose redaction takes its closing bracket', () => {
    expect(
      wasmLogFields(
        'ERROR sable_core::errors: error sending request for url (https://hs.example.org/_matrix/client/v3/rooms/!r:hs.example.org/typing/@u:hs.example.org) log_id="e19" context="set_typing"'
      )
    ).toEqual({
      message:
        'sable_core::errors: error sending request for url (https://[HOMESERVER]/_matrix/client/v3/rooms/![ROOM_ID]/typing/@[USER_ID]',
      fields: { log_id: 'e19', context: 'set_typing' },
    });
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
