import type { Event } from '@sentry/sveltekit';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

let scrubSentryEvent: typeof import('./sentry-event').scrubSentryEvent;

beforeAll(async () => {
  // The app's own host is read once, when the scrubbers load.
  vi.stubGlobal('location', { origin: 'https://app.sable.test' });
  vi.resetModules();
  ({ scrubSentryEvent } = await import('./sentry-event'));
});
afterAll(() => vi.unstubAllGlobals());

function withFrames(...filenames: string[]): Event {
  return {
    exception: {
      values: [
        {
          type: 'Error',
          value: 'boom',
          stacktrace: {
            frames: filenames.map((filename) => ({ filename, abs_path: filename })),
          },
        },
      ],
    },
  };
}

function framePaths(event: Event): string[] {
  return (event.exception?.values?.[0]?.stacktrace?.frames ?? []).flatMap((frame) => [
    frame.filename ?? '',
    frame.abs_path ?? '',
  ]);
}

test('redacts the room a stack frame was raised on', () => {
  const event = scrubSentryEvent(
    withFrames(
      'http://tauri.localhost/space/!RthWXhmURXhyPYlQfCr8ThBrAie47dhkCGO56FCGqLo/!3d2U6XbZAcdifkccjxycWT5AMjgafNWjfBG7dOZeAz0',
      'https://app.sable.test/rooms/!abc:example.org',
      'https://app.sable.test/rooms/%23chat%3Aexample.org'
    )
  );

  expect(framePaths(event)).toEqual([
    'http://tauri.localhost/space/![ROOM_ID]/![ROOM_ID]',
    'http://tauri.localhost/space/![ROOM_ID]/![ROOM_ID]',
    'https://app.sable.test/rooms/![ROOM_ID]',
    'https://app.sable.test/rooms/![ROOM_ID]',
    'https://app.sable.test/rooms/[ROOM_ALIAS]',
    'https://app.sable.test/rooms/[ROOM_ALIAS]',
  ]);
});

test('leaves the build assets a source map resolves alone', () => {
  const assets = [
    'https://app.sable.test/_app/immutable/chunks/DJKm-GGS.js',
    'https://app.sable.test/_app/immutable/assets/sable_model_bg.CtzK5TxK.wasm',
    'sable-app://app/_app/immutable/entry/app.BWGUsH_W.js',
    'sable-app://app/../node_modules/.pnpm/@sentry+core@11.8.0/node_modules/@sentry/core/build/esm/integrations/captureconsole.js',
    'http://tauri.localhost/_app/immutable/workers/assets/sable_wasm_bg-C8CU3l-q.wasm',
    '/service-worker.js',
    'wasm://wasm/01234567:wasm-function[13]:0x5678',
  ];
  const event = scrubSentryEvent(withFrames(...assets));

  expect(framePaths(event)).toEqual(assets.flatMap((asset) => [asset, asset]));
});

test('redacts the breadcrumbs already on the event', () => {
  const event = scrubSentryEvent({
    breadcrumbs: [
      { category: 'navigation', data: { from: '/rooms/!abc:example.org', to: '/home' } },
      { category: 'console', message: 'opened !abc:example.org for @alice:example.org' },
      { category: 'fetch', data: { url: 'https://matrix.example.org/_matrix/client/v3/sync' } },
    ],
  });

  expect(event.breadcrumbs).toEqual([
    { category: 'navigation', data: { from: '/rooms/![ROOM_ID]', to: '/home' } },
    { category: 'console', message: 'opened ![ROOM_ID] for @[USER_ID]' },
    { category: 'fetch', data: { url: 'https://[HOMESERVER]/_matrix/client/v3/sync' } },
  ]);
});

test('redacts the room the page was opened from', () => {
  const event = scrubSentryEvent({
    request: {
      url: 'https://app.sable.test/home',
      headers: {
        Referer: 'https://app.sable.test/rooms/!abc:example.org?code=secret',
        'User-Agent': 'Mozilla/5.0',
      },
    },
  });

  expect(event.request.headers).toEqual({
    Referer: 'https://app.sable.test/rooms/![ROOM_ID]?code=[REDACTED]',
    'User-Agent': 'Mozilla/5.0',
  });
});
