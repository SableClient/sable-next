import { afterEach, expect, test, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage: ((events: unknown) => void) | null = null;
  },
}));
vi.mock('#lib/platform/session-storage.js', () => ({ resetWebStorage: () => Promise.resolve() }));
const captureException = vi.fn();
vi.mock('@sentry/sveltekit', () => ({ captureException }));

const { createTauriTransport } = await import('./tauri');

afterEach(() => {
  vi.restoreAllMocks();
});

function headersOf(call: unknown[]): Record<string, string> {
  const options = call[2] as { headers: Record<string, string> };
  return options.headers;
}

test('percent-encodes a caption and a filename a header value cannot carry', async () => {
  invoke.mockResolvedValue(undefined);
  const transport = createTauriTransport();

  await transport.sendAttachment({
    roomId: '!room:example.org',
    filename: 'été 😂.png',
    mime: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
    caption: 'Next works well :3 😂',
    formattedCaption: '<a href="https://matrix.to/#/@one:example.org">One</a> 😂',
    mentions: ['@one:example.org'],
    mentionsRoom: true,
    inReplyTo: null,
    info: null,
    threadRoot: null,
    spoiler: true,
  });

  const headers = headersOf(invoke.mock.calls.at(-1) ?? []);
  expect(headers.filename).toBe(encodeURIComponent('été 😂.png'));
  expect(headers.caption).toBe(encodeURIComponent('Next works well :3 😂'));
  expect(headers['formatted-caption']).toBe(
    encodeURIComponent('<a href="https://matrix.to/#/@one:example.org">One</a> 😂')
  );
  expect(headers.mentions).toBe(encodeURIComponent(JSON.stringify(['@one:example.org'])));
  expect(headers['mentions-room']).toBe('true');
  expect(headers.spoiler).toBe('true');
  for (const value of Object.values(headers)) {
    expect(value).toMatch(/^[ -~]*$/);
  }
});

test('a throwing listener neither escapes the channel nor stops the batch', () => {
  invoke.mockResolvedValue(undefined);
  const transport = createTauriTransport();
  const subscribed = invoke.mock.calls.findLast(([command]) => command === 'subscribe_events');
  if (!subscribed) throw new Error('the transport did not subscribe to events');
  const { channel } = subscribed[1] as {
    channel: { onmessage: ((events: unknown) => void) | null };
  };

  vi.spyOn(console, 'error').mockImplementation(() => {});
  const seen: string[] = [];
  transport.subscribe(() => {
    throw new Error('listener exploded');
  });
  transport.subscribe((event) => {
    seen.push(event.type);
  });

  const batch = [{ type: 'sync_state' }, { type: 'sync_state' }];
  expect(() => channel.onmessage?.(batch)).not.toThrow();
  expect(seen).toEqual(['sync_state', 'sync_state']);
  expect(captureException).toHaveBeenCalledTimes(2);
});

test('a video stream is not whole until the end-of-stream marker arrives', async () => {
  let channel: { onmessage: ((chunk: unknown) => void) | null } | undefined;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === 'stream_video') {
      channel = (args as { chunks: typeof channel }).chunks;
    }
    return Promise.resolve(undefined);
  });
  const transport = createTauriTransport();
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  const chunks: Uint8Array[] = [];
  let settled = false;
  const streaming = transport
    .streamVideo('mxc://example.org/clip', 1, (chunk) => chunks.push(chunk))
    .then(() => {
      settled = true;
    });

  // The command resolves long before the channel has drained, so resolving on
  // it handed the renderer a random prefix of the video.
  await settle();
  expect(settled).toBe(false);

  channel?.onmessage?.(new Uint8Array([1, 2, 3]).buffer);
  channel?.onmessage?.(new Uint8Array([4]).buffer);
  await settle();
  expect(settled).toBe(false);

  channel?.onmessage?.(new ArrayBuffer(0));
  await streaming;

  expect(settled).toBe(true);
  expect(chunks.flatMap((chunk) => [...chunk])).toEqual([1, 2, 3, 4]);
});
