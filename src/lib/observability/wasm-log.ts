import { scrubMatrixIds } from './scrubbers';

const TITLE_LIMIT = 600;

export type WasmLogLevel = 'error' | 'warn' | 'info';

export function wasmLogLevel(line: string): WasmLogLevel {
  const level = /^\s*(TRACE|DEBUG|INFO|WARN|ERROR)\s/.exec(line)?.[1];
  if (level === 'ERROR') return 'error';
  if (level === 'WARN') return 'warn';
  return 'info';
}

/**
 * Only warnings in the SDK, but the room keys they carried are lost. Our own
 * code marks such warnings with `reported = true` instead.
 */
const REPORTED_SDK_WARNINGS = [
  'matrix_sdk_crypto::olm::account:',
  'matrix_sdk_crypto::session_manager::sessions:',
  'matrix_sdk_crypto::session_manager::group_sessions:',
  'matrix_sdk_crypto::gossiping::',
];
const REPORTED_FIELD = /\sreported=true\b/;

/** Warnings that explain a message or a call that could not be decrypted. */
export function isReportableCoreWarning(line: string): boolean {
  return (
    wasmLogLevel(line) === 'warn' &&
    (REPORTED_FIELD.test(line) || REPORTED_SDK_WARNINGS.some((target) => line.includes(target)))
  );
}

const UNREACHABLE =
  /Failed to fetch|Load failed|NetworkError|error sending request\b|tcp connect error|dns error|connection (?:refused|reset|closed)|operation timed out/i;
const SERVER_UNAVAILABLE = /status_code:\s*(?:429|5\d\d)\b|returned an error: \[(?:429|5\d\d)\b/;

export function isExpectedCoreFailure(line: string): boolean {
  return (
    UNREACHABLE.test(line) ||
    SERVER_UNAVAILABLE.test(line) ||
    /invalid_grant|refresh token was rejected/.test(line) ||
    line.includes('Failed to return /publicRooms') ||
    line.includes('The store is closed') ||
    line.includes('the signed one-time key was missing') ||
    line.includes('room_latest_events: Room is unknown')
  );
}

function withoutSpans(line: string): string {
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (depth === 0 && char === ':' && line[index + 1] === ' ') {
      const prefix = line.slice(0, index);
      return prefix.includes('{') ? line.slice(index + 2) : line;
    }
  }
  return line;
}

export function wasmErrorTitle(line: string): string {
  const message = scrubMatrixIds(
    withoutSpans(
      line
        .replace(/^\s*(?:ERROR|WARN)\s+/, '')
        .replace(REPORTED_FIELD, '')
        .replace(/"?JsValue\([^]*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
  ).replace(/[A-Za-z0-9+/]{40,}/g, '[KEY]');
  return message.length > TITLE_LIMIT ? `${message.slice(0, TITLE_LIMIT)}…` : message;
}

export function wasmErrorFingerprint(line: string): string {
  return wasmErrorTitle(line)
    .replace(/\{[^{}]*\}/g, '')
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}
