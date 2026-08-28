import { createSubscriber } from 'svelte/reactivity';

import { sanitizePayload, scrubMatrixIds } from './scrubbers.js';

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
const TRIM_SLACK = 200;
const ENABLED_KEY = 'sable_internal_debug';
const DISABLED_CATEGORIES_KEY = 'sable-debug-disabled-categories';
const consoleMethods = ['error', 'warn', 'info', 'debug'] as const;

type ConsoleMethod = (typeof consoleMethods)[number];

function readEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(ENABLED_KEY) === '1';
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

const buffer: DebugLogEntry[] = [];
/* eslint-disable svelte/prefer-svelte-reactivity */
const disabledCategories = new Set<DebugLogCategory>(readDisabledCategories());
const originalConsole = new Map<ConsoleMethod, (...args: unknown[]) => void>();
const captureListeners = new Set<(enabled: boolean) => void>();
/* eslint-enable svelte/prefer-svelte-reactivity */

let enabled = readEnabled();
let nextId = 1;
let lastEntry: DebugLogEntry | null = null;
let interceptingConsole = false;
let notify: (() => void) | undefined;
let notifyScheduled = false;

const subscribe = createSubscriber((update) => {
  notify = update;
  return () => {
    notify = undefined;
    notifyScheduled = false;
  };
});

function scheduleNotify(): void {
  if (notify === undefined || notifyScheduled) return;
  notifyScheduled = true;
  const flush = (): void => {
    notifyScheduled = false;
    notify?.();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

function append(entry: Omit<DebugLogEntry, 'id'>): void {
  if (
    lastEntry?.level === entry.level &&
    lastEntry.namespace === entry.namespace &&
    lastEntry.message === entry.message
  ) {
    return;
  }
  const stored: DebugLogEntry = { id: nextId, ...entry };
  nextId += 1;
  buffer.push(stored);
  lastEntry = stored;
  if (buffer.length > MAX_ENTRIES + TRIM_SLACK) buffer.splice(0, buffer.length - MAX_ENTRIES);
  scheduleNotify();
}

export const debugLog = {
  get enabled(): boolean {
    subscribe();
    return enabled;
  },
  get entries(): readonly DebugLogEntry[] {
    subscribe();
    return buffer;
  },
  get disabledCategories(): ReadonlySet<DebugLogCategory> {
    subscribe();
    return disabledCategories;
  },
};

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
      append({
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

export function setDebugLogging(next: boolean): void {
  enabled = next;
  if (next) interceptConsole();
  else restoreConsole();
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(ENABLED_KEY, next ? '1' : '0');
  }
  notify?.();
  for (const listener of captureListeners) listener(next);
}

export function onDebugLogCapture(listener: (enabled: boolean) => void): () => void {
  captureListeners.add(listener);
  listener(enabled);
  return () => {
    captureListeners.delete(listener);
  };
}

if (enabled) interceptConsole();

export function setDebugCategoryEnabled(category: DebugLogCategory, next: boolean): void {
  if (next) disabledCategories.delete(category);
  else disabledCategories.add(category);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(DISABLED_CATEGORIES_KEY, JSON.stringify([...disabledCategories]));
  }
  notify?.();
}

export function recordDebugLog(
  level: DebugLogLevel,
  category: DebugLogCategory,
  namespace: string,
  message: string,
  data?: unknown
): void {
  if (!enabled || disabledCategories.has(category)) return;
  append({
    timestamp: Date.now(),
    level,
    category,
    namespace,
    message: scrubMatrixIds(message),
    ...(data === undefined ? {} : { data: sanitizePayload(data) }),
  });
}

export function clearDebugLogs(): void {
  buffer.length = 0;
  lastEntry = null;
  notify?.();
}

export function exportDebugLogs(entries: readonly DebugLogEntry[] = buffer): string {
  /* eslint-disable-next-line svelte/prefer-svelte-reactivity */
  const iso = (value?: number): string => new Date(value ?? Date.now()).toISOString();
  return JSON.stringify(
    {
      exportedAt: iso(),
      logsCount: entries.length,
      logs: entries.map((entry) => ({ ...entry, timestamp: iso(entry.timestamp) })),
    },
    null,
    2
  );
}
