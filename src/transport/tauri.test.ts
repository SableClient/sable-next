import { expect, test, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    onmessage: ((events: unknown) => void) | null = null;
  },
}));
vi.mock('#lib/platform/session-storage.js', () => ({ resetWebStorage: () => Promise.resolve() }));

const { createTauriTransport } = await import('./tauri');

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
  });

  const headers = headersOf(invoke.mock.calls.at(-1) ?? []);
  expect(headers.filename).toBe(encodeURIComponent('été 😂.png'));
  expect(headers.caption).toBe(encodeURIComponent('Next works well :3 😂'));
  expect(headers['formatted-caption']).toBe(
    encodeURIComponent('<a href="https://matrix.to/#/@one:example.org">One</a> 😂')
  );
  expect(headers.mentions).toBe(encodeURIComponent(JSON.stringify(['@one:example.org'])));
  expect(headers['mentions-room']).toBe('true');
  for (const value of Object.values(headers)) {
    expect(value).toMatch(/^[ -~]*$/);
  }
});
