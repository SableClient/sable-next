// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  DesktopCallShortcut,
  DesktopCallShortcutEvent,
} from '#lib/platform/call-shortcut-types.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { rebind, resetAllBindings, shortcutCapture } from '#lib/ui/shortcuts/bindings.svelte.js';
import type { CallSession } from './call-session.svelte';
import { registerDesktopCallShortcuts } from './desktop-shortcuts.svelte';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  shortcutCapture.active = false;
  resetAllBindings();
  setPreference('callGlobalShortcuts', true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function setup() {
  let receive!: (event: DesktopCallShortcutEvent) => void;
  const offNative = vi.fn();
  const setCallShortcuts = vi.fn<(bindings: DesktopCallShortcut[]) => Promise<void>>(
    async () => {}
  );
  vi.stubGlobal('sableElectron', {
    setCallShortcuts,
    onCallShortcut: (callback: typeof receive) => {
      receive = callback;
      return offNative;
    },
  });
  const session = $state({
    lifecycle: 'active',
    mediaReady: true,
    listenOnly: false,
    inputMode: 'push-to-talk',
    desktopShortcutStatus: 'inactive',
    setTalking: vi.fn(async () => {}),
    toggleMicrophone: vi.fn(async () => {}),
  });
  stop = registerDesktopCallShortcuts(session as unknown as CallSession);
  flushSync();
  return {
    session,
    setCallShortcuts,
    offNative,
    receive: (event: DesktopCallShortcutEvent) => {
      receive(event);
    },
  };
}

test('registers effective bindings during an active call and tracks rebinding', () => {
  const { setCallShortcuts } = setup();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: 'talk', binding: 'mod+shift+t' }),
    expect.objectContaining({ id: 'mute', binding: 'mod+shift+m' }),
  ]);
  rebind('call.pushToTalk', 'alt+space');
  flushSync();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: 'talk', binding: 'alt+space' }),
    expect.objectContaining({ id: 'mute' }),
  ]);
});

test('background key events reach the call and cleanup releases every source', () => {
  const { session, receive, offNative, setCallShortcuts } = setup();
  receive({ id: 'talk', pressed: true });
  expect(session.setTalking).toHaveBeenLastCalledWith(true, 'desktop');
  stop?.();
  stop = undefined;
  expect(offNative).toHaveBeenCalledOnce();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([]);
  expect(session.setTalking).toHaveBeenCalledWith(false, 'desktop');
});

test('suspends desktop keys while recording a binding and restores them afterwards', () => {
  const { setCallShortcuts, session, receive } = setup();
  shortcutCapture.active = true;
  flushSync();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([]);
  session.setTalking.mockClear();
  receive({ id: 'talk', pressed: true });
  expect(session.setTalking).not.toHaveBeenCalled();
  shortcutCapture.active = false;
  flushSync();
  expect(setCallShortcuts.mock.calls.at(-1)?.[0]).toHaveLength(2);
});

test('leaving, listen-only calls and disabling desktop keys remove native registrations', () => {
  const { session, setCallShortcuts } = setup();
  session.lifecycle = 'leaving';
  flushSync();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([]);
  session.lifecycle = 'active';
  session.listenOnly = true;
  flushSync();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([]);
  session.listenOnly = false;
  setPreference('callGlobalShortcuts', false);
  flushSync();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([]);
});

test('a portal or registration failure is exposed in the call UI', () => {
  const { session, receive } = setup();
  receive({ status: 'error' });
  expect(session.desktopShortcutStatus).toBe('error');
  receive({ status: 'ready', backend: 'passive' });
  expect(session.desktopShortcutStatus).toBe('passive');
});

test('typing in Sable ignores portal presses without re-registering native shortcuts', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const { setCallShortcuts, session, receive } = setup();
  const registrations = setCallShortcuts.mock.calls.length;
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  flushSync();
  expect(setCallShortcuts).toHaveBeenCalledTimes(registrations);
  receive({ id: 'talk', pressed: true });
  expect(session.setTalking).not.toHaveBeenCalledWith(true, 'desktop');
});

test('voice activity mode only registers push-to-mute globally', () => {
  const { session, setCallShortcuts } = setup();
  session.inputMode = 'voice-activity';
  flushSync();
  expect(setCallShortcuts).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'mute' })]);
});

test('mute toggles on press, not release', () => {
  const { session, receive } = setup();
  receive({ id: 'mute', pressed: true });
  expect(session.toggleMicrophone).toHaveBeenCalledOnce();
  receive({ id: 'mute', pressed: false });
  expect(session.toggleMicrophone).toHaveBeenCalledOnce();
});
