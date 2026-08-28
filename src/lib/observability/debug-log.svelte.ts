import { sanitizePayload, scrubMatrixIds } from './scrubbers.js';
import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DebugLogCategory =
  | 'sync'
  | 'network'
  | 'notification'
  | 'message'
  | 'media'
  | 'call'
  | 'ui'
  | 'timeline'
  | 'error'
  | 'general';

export type DebugLogEntry = {
  id: number;
  timestamp: number;
  level: DebugLogLevel;
  category: DebugLogCategory;
  namespace: string;
  message: string;
  data?: unknown;
};

const MAX_ENTRIES = 1000;
const MAX_LOG_ENTRIES_PER_FLUSH = 5;
const DISABLED_CATEGORIES_KEY = 'sable-debug-disabled-categories';
const consoleMethods = ['error', 'warn', 'info', 'debug'] as const;
const originalConsole = new SvelteMap<
  (typeof consoleMethods)[number],
  (...args: unknown[]) => void
>();
let interceptingConsole = false;
const captureListeners = new SvelteSet<(enabled: boolean) => void>();
const pendingLogEntries: Omit<DebugLogEntry, 'id'>[] = [];
let logFlushQueued = false;
let droppedLogEntries = 0;

function queueLogEntry(entry: Omit<DebugLogEntry, 'id'>): void {
  const last = pendingLogEntries.at(-1) ?? debugLog.entries.at(-1);
  if (
    last &&
    last.level === entry.level &&
    last.namespace === entry.namespace &&
    last.message === entry.message
  ) {
    return;
  }
  if (pendingLogEntries.length >= MAX_LOG_ENTRIES_PER_FLUSH) {
    droppedLogEntries += 1;
    return;
  }
  pendingLogEntries.push(entry);
  if (logFlushQueued) return;
  logFlushQueued = true;
  queueMicrotask(() => {
    logFlushQueued = false;
    if (!debugLog.enabled || pendingLogEntries.length === 0) {
      pendingLogEntries.length = 0;
      droppedLogEntries = 0;
      return;
    }
    const entries = pendingLogEntries.map((pending, index) => ({
      id: debugLog.nextId + index,
      ...pending,
    }));
    if (droppedLogEntries > 0) {
      entries.push({
        id: debugLog.nextId + entries.length,
        timestamp: Date.now(),
        level: 'debug',
        category: 'general',
        namespace: 'console',
        message: `+${droppedLogEntries} log entries dropped`,
      });
      droppedLogEntries = 0;
    }
    debugLog.nextId += entries.length;
    pendingLogEntries.length = 0;
    debugLog.entries.push(...entries);
    if (debugLog.entries.length > MAX_ENTRIES) {
      debugLog.entries.splice(0, debugLog.entries.length - MAX_ENTRIES);
    }
  });
}

function readDisabledCategories(): DebugLogCategory[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISABLED_CATEGORIES_KEY) ?? '[]');
    return Array.isArray(value)
      ? (value.filter((item) => typeof item === 'string') as DebugLogCategory[])
      : [];
  } catch {
    return [];
  }
}

export const debugLog = $state({
  enabled:
    typeof localStorage !== 'undefined' && localStorage.getItem('sable_internal_debug') === '1',
  entries: [] as DebugLogEntry[],
  nextId: 1,
  disabledCategories: new SvelteSet<DebugLogCategory>(readDisabledCategories()),
});

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack ?? arg.message;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function interceptConsole(): void {
  if (originalConsole.size > 0) return;
  for (const method of consoleMethods) {
    const original = console[method].bind(console);
    originalConsole.set(method, original);
    console[method] = (...args: unknown[]) => {
      if (interceptingConsole) {
        original(...args);
        return;
      }

      interceptingConsole = true;
      queueLogEntry({
        timestamp: Date.now(),
        level: method === 'error' ? 'error' : method === 'warn' ? 'warn' : method,
        category: method === 'error' ? 'error' : 'general',
        namespace: 'console',
        message: scrubMatrixIds(formatConsoleArgs(args)),
      });
      original(...args);
      interceptingConsole = false;
    };
  }
}

function restoreConsole(): void {
  for (const method of consoleMethods) {
    const original = originalConsole.get(method);
    if (original) console[method] = original;
  }
  originalConsole.clear();
}

export function setDebugLogging(enabled: boolean): void {
  debugLog.enabled = enabled;
  if (enabled) interceptConsole();
  else restoreConsole();
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('sable_internal_debug', enabled ? '1' : '0');
  }
  for (const listener of captureListeners) listener(enabled);
}

export function onDebugLogCapture(listener: (enabled: boolean) => void): () => void {
  captureListeners.add(listener);
  listener(debugLog.enabled);
  return () => {
    captureListeners.delete(listener);
  };
}

if (debugLog.enabled) interceptConsole();

export function setDebugCategoryEnabled(category: DebugLogCategory, enabled: boolean): void {
  if (enabled) debugLog.disabledCategories.delete(category);
  else debugLog.disabledCategories.add(category);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(DISABLED_CATEGORIES_KEY, JSON.stringify([...debugLog.disabledCategories]));
  }
}

export function recordDebugLog(
  level: DebugLogLevel,
  category: DebugLogCategory,
  namespace: string,
  message: string,
  data?: unknown
): void {
  if (!debugLog.enabled || debugLog.disabledCategories.has(category)) return;
  queueLogEntry({
    timestamp: Date.now(),
    level,
    category,
    namespace,
    message: scrubMatrixIds(message),
    ...(data === undefined ? {} : { data: sanitizePayload(data) }),
  });
}

export function clearDebugLogs(): void {
  debugLog.entries.length = 0;
}

export function exportDebugLogs(entries: readonly DebugLogEntry[] = debugLog.entries): string {
  return JSON.stringify(
    {
      exportedAt: new SvelteDate().toISOString(),
      logsCount: entries.length,
      logs: entries.map((entry) => ({
        ...entry,
        timestamp: new SvelteDate(entry.timestamp).toISOString(),
      })),
    },
    null,
    2
  );
}
