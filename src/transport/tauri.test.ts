import { afterEach, expect, test, vi } from 'vitest';

const invoke = vi.fn();
const channels: { onmessage: ((events: unknown) => void) | null }[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage: ((events: unknown) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock('#lib/platform/session-storage.js', () => ({ resetWebStorage: () => Promise.resolve() }));
const captureException = vi.fn();
vi.mock('@sentry/sveltekit', () => ({ captureException }));

const { createTauriLink, createTauriTransport } = await import('./tauri');

afterEach(() => {
  vi.restoreAllMocks();
});

function headersOf(call: unknown[]): Record<string, string> {
  const options = call[2] as { headers: Record<string, string> };
  return options.headers;
}

test.each([undefined, false, true])(
  'passes background=%s for media downloads',
  async (background) => {
    invoke.mockResolvedValue(new Uint8Array([7]).buffer);
    const transport = createTauriTransport();
    await expect(
      transport.fetchMedia('mxc://example.org/emote', 0, 0, background)
    ).resolves.toEqual(new Uint8Array([7]));
    expect(invoke).toHaveBeenCalledWith('fetch_media', {
      source: 'mxc://example.org/emote',
      width: 0,
      height: 0,
      background: background ?? false,
    });
  }
);

test('percent-encodes the attachment request header', async () => {
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
  expect(JSON.parse(decodeURIComponent(headers.request))).toMatchObject({
    filename: 'été 😂.png',
    caption: 'Next works well :3 😂',
    formatted_caption: '<a href="https://matrix.to/#/@one:example.org">One</a> 😂',
    mentions: ['@one:example.org'],
    mentions_room: true,
    spoiler: true,
  });
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

test('a cache reset goes through the core and still resolves when the core fails it', async () => {
  invoke.mockImplementation((command: string) =>
    command === 'call' ? Promise.reject(new Error('failed')) : Promise.resolve(undefined)
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  captureException.mockClear();
  const transport = createTauriTransport();

  await expect(transport.resetCaches(['a1'])).resolves.toBeUndefined();

  expect(invoke).toHaveBeenCalledWith('call', {
    method: 'session.reset_local_cache',
    params: {},
  });
  expect(captureException).toHaveBeenCalledTimes(1);
});

test('the runtime link connects its window first and then makes its calls', async () => {
  invoke.mockReset();
  invoke.mockResolvedValue({ schema: 's', slices: [] });
  const link = createTauriLink();

  await link.handshake();
  await link.range(4, { start: 0, end: 10 });

  expect(invoke.mock.calls.map((call) => String(call[0]))).toEqual([
    'runtime_connect',
    'runtime_handshake',
    'runtime_range',
  ]);
  expect(invoke).toHaveBeenLastCalledWith('runtime_range', {
    sub: 4,
    range: { start: 0, end: 10 },
  });
});

test('the runtime link delivers the batches of its channel and rejects with the error code', async () => {
  invoke.mockReset();
  invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce('unknown_sub');
  const link = createTauriLink();
  const heard = vi.fn();
  link.onBatch(heard);

  channels.at(-1)?.onmessage?.({ tick: 2, events: [] });

  expect(heard).toHaveBeenCalledWith({ tick: 2, events: [] });
  await expect(link.resync(9)).rejects.toThrow('unknown_sub');
});
