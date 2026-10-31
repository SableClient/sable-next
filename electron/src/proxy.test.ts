import { expect, test } from 'vitest';

import { coreProxy } from './proxy';

test.each([
  ['socks5://127.0.0.1:9050', 'socks5h://127.0.0.1:9050'],
  ['socks://proxy.lan:1080', 'socks4://proxy.lan:1080'],
  ['socks4://proxy.lan:1080', 'socks4://proxy.lan:1080'],
  ['http://proxy.lan:3128', 'http://proxy.lan:3128'],
  ['proxy.lan:3128', 'proxy.lan:3128'],
])('%s reaches the core as %s', (value, expected) => {
  expect(coreProxy(value)).toBe(expected);
});

test('per-scheme rules are refused', () => {
  expect(() => coreProxy('http=a:1;https=b:2')).toThrow('per-scheme proxy rules');
});
