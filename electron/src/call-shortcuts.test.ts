import { expect, test, vi } from 'vitest';
import { CallShortcuts, nativeBinding, validBindings } from './call-shortcuts';
import type {
  DesktopCallShortcutBackend,
  DesktopCallShortcutEvent,
} from '../../src/lib/platform/call-shortcut-types';

const talk = { id: 'talk', binding: 'mod+shift+t', description: 'Push to talk' } as const;
const mute = { id: 'mute', binding: 'mod+shift+m', description: 'Mute microphone' } as const;

function harness({
  passive = true,
  platform = 'darwin',
  wayland = false,
}: { passive?: boolean; platform?: string; wayland?: boolean } = {}) {
  const send = vi.fn<(event: DesktopCallShortcutEvent) => void>();
  const handles: {
    backend: DesktopCallShortcutBackend;
    close: ReturnType<typeof vi.fn>;
    notify: (json: string) => void;
  }[] = [];
  const load = () => ({
    NativeCallShortcuts: class {
      close = vi.fn();
      constructor(
        _bindings: unknown,
        readonly backend: DesktopCallShortcutBackend,
        _appId: string,
        readonly notify: (json: string) => void
      ) {
        if (backend === 'passive' && !passive) throw new Error('Accessibility not granted');
        handles.push(this);
      }
    },
  });
  const shortcuts = new CallShortcuts(send, load);
  shortcuts.configure([talk, mute], platform, wayland, 'moe.sable.client');
  return { shortcuts, handles, send };
}

test('normalizes custom bindings for native hotkeys and the Wayland portal', () => {
  expect(nativeBinding(talk, true)).toMatchObject({
    hotkey: 'SUPER+SHIFT+t',
    passive: 'SUPER+SHIFT+t',
    trigger: 'SUPER+SHIFT+t',
  });
  expect(nativeBinding(talk, false)).toMatchObject({
    hotkey: 'CTRL+SHIFT+t',
    trigger: 'CTRL+SHIFT+t',
  });
  expect(nativeBinding({ ...talk, binding: 'alt+space' }, false)).toMatchObject({
    hotkey: 'ALT+Space',
    trigger: 'ALT+space',
  });
  expect(nativeBinding({ ...talk, binding: 'num0' }, false)).toMatchObject({
    hotkey: 'Numpad0',
    passive: 'keypad0',
    trigger: 'KP_0',
  });
  expect(nativeBinding({ ...talk, binding: 'f12' }, false)).toMatchObject({
    hotkey: 'f12',
    trigger: 'F12',
  });
  expect(nativeBinding({ ...talk, binding: 'ctrl+\\' }, false)).toMatchObject({
    hotkey: 'CTRL+Backslash',
    passive: 'CTRL+\\',
    trigger: 'CTRL+backslash',
  });
});

test.each([
  null,
  {},
  [{ ...talk, id: 'app.searchMessages' }],
  [talk, talk],
  [{ ...talk, binding: 1 }],
  [{ ...talk, description: null }],
  [talk, mute, talk],
])('rejects malformed desktop bindings: %j', (bindings) => {
  expect(validBindings(bindings)).toBe(false);
});

test('accepts only the two call shortcut actions or an empty cleanup request', () => {
  expect(validBindings([talk, mute])).toBe(true);
  expect(validBindings([])).toBe(true);
});

test.each(['talk', 'mute'])('%s fires once per press', (id) => {
  const { shortcuts, handles, send } = harness();
  handles[0]?.notify(JSON.stringify({ id, pressed: true }));
  handles[0]?.notify(JSON.stringify({ id, pressed: true }));
  handles[0]?.notify(JSON.stringify({ id, pressed: false }));
  expect(send.mock.calls.map(([event]) => event)).toEqual([
    { status: 'ready', backend: 'passive' },
    { id, pressed: true },
    { id, pressed: false },
  ]);
  shortcuts.stop();
  expect(handles[0]?.close).toHaveBeenCalledOnce();
});

test('rebinding releases old holds and ignores events from the old registration', () => {
  const { shortcuts, handles, send } = harness();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  shortcuts.configure([mute], 'linux', true, 'moe.sable.client');
  expect(send.mock.calls.slice(-2).map(([event]) => event)).toEqual([
    { id: 'talk', pressed: false },
    { status: 'ready', backend: 'passive' },
  ]);
  send.mockClear();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  expect(send).not.toHaveBeenCalled();
  handles[1]?.notify(JSON.stringify({ id: 'mute', pressed: true }));
  expect(send).toHaveBeenCalledExactlyOnceWith({ id: 'mute', pressed: true });
  shortcuts.stop();
});

test('a lost native session releases held keys and reports the failure', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { shortcuts, handles, send } = harness();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  handles[0]?.notify(JSON.stringify({ status: 'error', error: 'Portal disconnected' }));
  expect(send.mock.calls.slice(-2).map(([event]) => event)).toEqual([
    { id: 'talk', pressed: false },
    { status: 'error', error: 'Portal disconnected' },
  ]);
  expect(handles[0]?.close).toHaveBeenCalledOnce();
  shortcuts.stop();
  warn.mockRestore();
});

test('sleep or screen lock releases held keys without removing their registration', () => {
  const { shortcuts, handles, send } = harness();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  shortcuts.releaseAll();
  expect(send).toHaveBeenLastCalledWith({ id: 'talk', pressed: false });
  expect(handles[0]?.close).not.toHaveBeenCalled();
  send.mockClear();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: false }));
  expect(send).not.toHaveBeenCalled();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  expect(send).toHaveBeenCalledExactlyOnceWith({ id: 'talk', pressed: true });
  shortcuts.stop();
});

test('listens passively first so bound keys keep working in other apps', () => {
  const { shortcuts, handles, send } = harness();
  expect(handles.map((h) => h.backend)).toEqual(['passive']);
  expect(shortcuts.backend).toBe('passive');
  expect(send).toHaveBeenCalledWith({ status: 'ready', backend: 'passive' });
  shortcuts.stop();
});

test('passive presses are left to the in-app handler while Sable has focus', () => {
  const { shortcuts, handles, send } = harness();
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  shortcuts.setFocused(true);
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: false }));
  handles[0]?.notify(JSON.stringify({ id: 'mute', pressed: true }));
  expect(send.mock.calls.slice(1).map(([event]) => event)).toEqual([
    { id: 'talk', pressed: true },
    { id: 'talk', pressed: false },
  ]);
  expect(handles).toHaveLength(1);
  shortcuts.stop();
});

test('exclusive hotkeys are only held while Sable is in the background', () => {
  const { shortcuts, handles, send } = harness({ passive: false });
  expect(shortcuts.backend).toBe('exclusive');
  expect(handles.map((h) => h.backend)).toEqual(['exclusive']);
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  shortcuts.setFocused(true);
  expect(handles[0]?.close).toHaveBeenCalledOnce();
  expect(send).toHaveBeenLastCalledWith({ id: 'talk', pressed: false });
  shortcuts.setFocused(false);
  expect(handles.map((h) => h.backend)).toEqual(['exclusive', 'exclusive']);
  shortcuts.stop();
});

test('configuring while focused defers exclusive registration until Sable loses focus', () => {
  const { shortcuts, handles } = harness({ passive: false });
  shortcuts.setFocused(true);
  shortcuts.configure([talk], 'win32', false, 'moe.sable.client');
  expect(handles).toHaveLength(1);
  expect(shortcuts.backend).toBe('exclusive');
  shortcuts.setFocused(false);
  expect(handles).toHaveLength(2);
  shortcuts.stop();
});

test('Wayland falls back to the portal, which keeps its session and forwards focused presses', () => {
  const { shortcuts, handles, send } = harness({
    passive: false,
    platform: 'linux',
    wayland: true,
  });
  expect(handles.map((h) => h.backend)).toEqual(['portal']);
  expect(send).not.toHaveBeenCalled();
  handles[0]?.notify(JSON.stringify({ status: 'ready' }));
  expect(send).toHaveBeenLastCalledWith({ status: 'ready', backend: 'portal' });
  shortcuts.setFocused(true);
  handles[0]?.notify(JSON.stringify({ id: 'talk', pressed: true }));
  expect(send).toHaveBeenLastCalledWith({ id: 'talk', pressed: true });
  expect(handles[0]?.close).not.toHaveBeenCalled();
  shortcuts.stop();
});
