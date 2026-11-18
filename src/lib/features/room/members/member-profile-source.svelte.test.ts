// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { mockRpc } from '#lib/core/__mocks__/context.js';

const { toastError, toastInfo } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('#lib/ui/toasts.svelte.js', () => ({ toasts: { error: toastError, info: toastInfo } }));

import { MemberProfileSource } from './member-profile-source.svelte.js';

const userProfileSource = vi.fn();
const event = vi.fn();
const source = new MemberProfileSource({
  rpc: mockRpc({ account: { userProfileSource }, room_state: { event } }),
});

beforeEach(() => {
  vi.clearAllMocks();
  source.open = false;
});

test('a loaded profile source opens with its text', async () => {
  userProfileSource.mockResolvedValueOnce('{"a":1}');
  await source.viewProfile('@a:example.org');
  expect(source.open).toBe(true);
  expect(source.text).toBe('{"a":1}');
});

test('a failed profile source load reports an error and stays closed', async () => {
  userProfileSource.mockRejectedValueOnce(new Error('down'));
  await source.viewProfile('@a:example.org');
  expect(source.open).toBe(false);
  expect(toastError).toHaveBeenCalledOnce();
});

test('a member event is shown as formatted JSON', async () => {
  event.mockResolvedValueOnce({ membership: 'join' });
  await source.viewMemberEvent('!r:example.org', '@a:example.org');
  expect(source.open).toBe(true);
  expect(source.text).toBe('{\n  "membership": "join"\n}');
});

test('a missing member event is reported instead of opened', async () => {
  event.mockResolvedValueOnce(null);
  await source.viewMemberEvent('!r:example.org', '@a:example.org');
  expect(source.open).toBe(false);
  expect(toastInfo).toHaveBeenCalledOnce();
});
