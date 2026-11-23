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

function unscrubbedLine(line: string): string {
  return withoutSpans(
    line
      .replace(/^\s*(?:ERROR|WARN)\s+/, '')
      .replace(REPORTED_FIELD, '')
      .replace(/"?JsValue\([^]*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function scrubbed(text: string): string {
  return scrubMatrixIds(text).replace(/[A-Za-z0-9+/]{40,}/g, '[KEY]');
}

function truncated(message: string): string {
  return message.length > TITLE_LIMIT ? `${message.slice(0, TITLE_LIMIT)}…` : message;
}

export function wasmErrorTitle(line: string): string {
  return truncated(scrubbed(unscrubbedLine(line)));
}

const FIELD_START = /^ [A-Za-z_][\w.]*=/;

/**
 * Splits off the `key=value` fields `tracing` writes after the message. It reads
 * the line before redaction, which can take a URL's closing bracket with it.
 */
export function wasmLogFields(line: string): { message: string; fields: Record<string, string> } {
  const text = unscrubbedLine(line);
  const starts: number[] = [];
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === ' ' && FIELD_START.test(text.slice(index, index + 64))) {
      starts.push(index);
    }
  }
  const fields: Record<string, string> = {};
  starts.forEach((start, position) => {
    const field = text.slice(start + 1, starts[position + 1]);
    const equals = field.indexOf('=');
    fields[field.slice(0, equals)] = scrubbed(field.slice(equals + 1)).replace(/^"([^]*)"$/, '$1');
  });
  return { message: truncated(scrubbed(text.slice(0, starts[0]))), fields };
}

/** Groups on the target and message alone, since the fields vary within one failure. */
export function wasmErrorFingerprint(line: string): string {
  return normalized(wasmLogFields(line).message);
}

/** Tells a repeated line from a new one, fields included. */
export function wasmErrorKey(line: string): string {
  return normalized(wasmErrorTitle(line));
}

function normalized(message: string): string {
  return message
    .replace(/\{[^{}]*\}/g, '')
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}
