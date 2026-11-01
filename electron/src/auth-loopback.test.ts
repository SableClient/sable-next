import { afterEach, expect, test, vi } from 'vitest';

import { AuthLoopback } from './auth-loopback';

let loopback: AuthLoopback | undefined;

afterEach(() => {
  loopback?.close();
});

test('listens on the IPv4 loopback and delivers the callback once', async () => {
  const onCallback = vi.fn();
  loopback = new AuthLoopback(onCallback);
  const redirectUri = await loopback.start();
  expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  expect((await fetch(new URL('/favicon.ico', redirectUri))).status).toBe(404);
  const response = await fetch(`${redirectUri}?code=code&state=state`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(onCallback).toHaveBeenCalledExactlyOnceWith(`${redirectUri}?code=code&state=state`);

  await expect(fetch(`${redirectUri}?code=again&state=state`)).rejects.toThrow();
  expect(onCallback).toHaveBeenCalledOnce();
});

test('rejects other methods and stops the previous listener on restart', async () => {
  const onCallback = vi.fn();
  loopback = new AuthLoopback(onCallback);
  const first = await loopback.start();
  expect((await fetch(`${first}?code=code`, { method: 'POST' })).status).toBe(404);

  const second = await loopback.start();
  expect(second).not.toBe(first);
  await expect(fetch(`${first}?code=code&state=state`)).rejects.toThrow();
  expect(onCallback).not.toHaveBeenCalled();
});
