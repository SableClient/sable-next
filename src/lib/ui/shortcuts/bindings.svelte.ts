import { SvelteMap } from 'svelte/reactivity';

import { findShortcutConflicts } from './binding.js';
import { SHORTCUTS, type ShortcutDefinition, type ShortcutId } from './shortcuts.js';

const STORAGE_KEY = 'sable-shortcut-bindings';
const SHORTCUT_IDS = new Set<string>(SHORTCUTS.map((shortcut) => shortcut.id));

function load(): Array<[string, string]> {
  if (typeof localStorage === 'undefined') return [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];

    return Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        SHORTCUT_IDS.has(entry[0]) && typeof entry[1] === 'string' && entry[1] !== ''
    );
  } catch {
    return [];
  }
}

const overrides = new SvelteMap<string, string>(load());

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(overrides)));
  } catch (error) {
    console.debug('[sable shortcuts] bindings not persisted', error);
  }
}

export function effectiveBinding(shortcut: ShortcutDefinition): string {
  return overrides.get(shortcut.id) ?? shortcut.binding;
}

export function isRebound(id: ShortcutId): boolean {
  return overrides.has(id);
}

export function effectiveShortcuts(): ShortcutDefinition[] {
  return SHORTCUTS.map((shortcut) => ({ ...shortcut, binding: effectiveBinding(shortcut) }));
}

export function rebind(id: ShortcutId, binding: string): void {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id);
  if (!shortcut) return;

  if (binding === shortcut.binding) overrides.delete(id);
  else overrides.set(id, binding);
  persist();
}

export function resetBinding(id: ShortcutId): void {
  overrides.delete(id);
  persist();
}

export function resetAllBindings(): void {
  overrides.clear();
  persist();
}

export function conflictsWith(id: ShortcutId, binding: string, isMac: boolean): ShortcutId[] {
  const candidates = effectiveShortcuts().map((shortcut) => ({
    id: shortcut.id,
    binding: shortcut.id === id ? binding : shortcut.binding,
    scope: 'global',
  }));

  return findShortcutConflicts(candidates, isMac)
    .filter(([a, b]) => a.id === id || b.id === id)
    .map(([a, b]) => (a.id === id ? b.id : a.id) as ShortcutId);
}
