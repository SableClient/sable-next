import { scrubMatrixIds } from './scrubbers';

const TITLE_LIMIT = 600;

export type WasmLogLevel = 'error' | 'warn' | 'info';

export function wasmLogLevel(line: string): WasmLogLevel {
  const level = /^\s*(TRACE|DEBUG|INFO|WARN|ERROR)\s/.exec(line)?.[1];
  if (level === 'ERROR') return 'error';
  if (level === 'WARN') return 'warn';
  return 'info';
}

/** Starts a line the Rust side decided to report, see `REPORTED_LOG_MARK` in `binding.rs`. */
const REPORTED_MARK = '\u001e';
const REPORTED_FIELD = /\sreported=true\b/;

export function readCoreLine(line: string): { text: string; reported: boolean } {
  const reported = line.startsWith(REPORTED_MARK);
  return { text: reported ? line.slice(REPORTED_MARK.length) : line, reported };
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
