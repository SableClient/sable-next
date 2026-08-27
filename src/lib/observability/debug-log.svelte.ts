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
const DISABLED_CATEGORIES_KEY = 'sable-debug-disabled-categories';
const consoleMethods = ['error', 'warn', 'info', 'debug'] as const;
const originalConsole = new SvelteMap<
  (typeof consoleMethods)[number],
  (...args: unknown[]) => void
>();

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
      recordDebugLog(
        method === 'error' ? 'error' : method === 'warn' ? 'warn' : method,
        method === 'error' ? 'error' : 'general',
        'console',
        formatConsoleArgs(args)
      );
      original(...args);
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
  debugLog.entries.push({
    id: debugLog.nextId++,
    timestamp: Date.now(),
    level,
    category,
    namespace,
    message: scrubMatrixIds(message),
    ...(data === undefined ? {} : { data: sanitizePayload(data) }),
  });
  if (debugLog.entries.length > MAX_ENTRIES) debugLog.entries.shift();
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
