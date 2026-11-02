import { beforeEach, expect, test, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));
vi.mock('electron', () => ({ shell: { openExternal } }));

import { historyDirection, openExternal as openLink, originOf } from './navigation';

beforeEach(() => {
  vi.clearAllMocks();
});

test.each(['not a URL', '', 'https://['])('rejects malformed URL %j without throwing', (url) => {
  expect(originOf(url)).toBe('');
  expect(() => {
    openLink(url);
  }).not.toThrow();
  expect(openExternal).not.toHaveBeenCalled();
});

test.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'sable-app://app/'])(
  'does not send %s to the OS',
  (url) => {
    openLink(url);
    expect(openExternal).not.toHaveBeenCalled();
  }
);

test.each(['https://example.org/', 'http://localhost/', 'mailto:user@example.org', 'tel:+123456'])(
  'opens an allowed external URL %s',
  (url) => {
    openLink(url);
    expect(openExternal).toHaveBeenCalledWith(url);
  }
);

test('compares the full app origin rather than a URL prefix', () => {
  expect(originOf('sable-app://app/room')).toBe('sable-app://app');
  expect(originOf('sable-app://app.evil.test/')).not.toBe('sable-app://app');
  expect(originOf('https://app/')).not.toBe('sable-app://app');
});

test('handles OS link-opening failures', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  openExternal.mockRejectedValueOnce(new Error('no handler'));
  openLink('https://example.org/');
  await Promise.resolve();
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

const keys = { alt: false, control: false, meta: false, shift: false };

test.each([
  ['linux', { ...keys, key: 'ArrowLeft', alt: true }, 'back'],
  ['win32', { ...keys, key: 'ArrowRight', alt: true }, 'forward'],
  ['linux', { ...keys, key: 'ArrowLeft', alt: true, shift: true }, null],
  ['linux', { ...keys, key: 'ArrowLeft', alt: true, control: true }, null],
  ['linux', { ...keys, key: 'ArrowLeft' }, null],
  ['darwin', { ...keys, key: '[', meta: true }, 'back'],
  ['darwin', { ...keys, key: ']', meta: true }, 'forward'],
  ['darwin', { ...keys, key: 'ArrowLeft', alt: true }, null],
] as const)('maps %s %o to %s', (platform, input, direction) => {
  expect(historyDirection(input, platform)).toBe(direction);
});
