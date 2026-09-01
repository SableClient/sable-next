import { scrubMatrixIds } from './scrubbers';

const TITLE_LIMIT = 240;

export type WasmLogLevel = 'error' | 'warn' | 'info';

export function wasmLogLevel(line: string): WasmLogLevel {
  const level = /^\s*(TRACE|DEBUG|INFO|WARN|ERROR)\s/.exec(line)?.[1];
  if (level === 'ERROR') return 'error';
  if (level === 'WARN') return 'warn';
  return 'info';
}

export function wasmErrorTitle(line: string): string {
  const message = scrubMatrixIds(line.replace(/^\s*ERROR\s+/, '').trim());
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
