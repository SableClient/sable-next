import { afterEach, expect, test, vi } from 'vitest';

import { uploadTimeoutMs, withUploadDeadline } from './upload-deadline';

const HOST = 'https://hs.example';

function capturing() {
  const seen: Request[] = [];
  const base = vi.fn((input: RequestInfo | URL) => {
    if (input instanceof Request) seen.push(input);
    return Promise.resolve(new Response('{}'));
  });
  return { base: base as unknown as typeof fetch, seen, calls: base.mock.calls };
}

function upload(bytes: number, signal?: AbortSignal, path = '/_matrix/media/v3/upload') {
  return new Request(`${HOST}${path}`, { method: 'POST', body: new Uint8Array(bytes), signal });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('sizes the deadline like the SDK does natively', () => {
  expect(uploadTimeoutMs(0)).toBe(300_000);
  expect(uploadTimeoutMs(125_000 * 600)).toBe(600_000);
});

test('aborts an upload that outlives its deadline', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const { base, seen } = capturing();

  await withUploadDeadline(base)(upload(125_000 * 400));

  expect(timeout).toHaveBeenCalledWith(400_000);
  expect(seen[0]?.signal.aborted).toBe(false);
  deadline.abort(new DOMException('timed out', 'TimeoutError'));
  expect(seen[0]?.signal.aborted).toBe(true);
});

test('keeps the caller able to abort the upload', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  const caller = new AbortController();
  const { base, seen } = capturing();

  await withUploadDeadline(base)(upload(10, caller.signal));
  caller.abort();

  expect(seen[0]?.signal.aborted).toBe(true);
});

test('sends the upload body unchanged', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  const { base, seen } = capturing();

  await withUploadDeadline(base)(
    upload(1234, undefined, '/_matrix/media/v3/upload/hs.example/abc')
  );

  const [sent] = seen;
  expect(sent).toBeDefined();
  expect((await sent.arrayBuffer()).byteLength).toBe(1234);
});

test.each([
  ['a download', new Request(`${HOST}/_matrix/client/v1/media/download/hs.example/abc`)],
  ['a sync', new Request(`${HOST}/_matrix/client/unstable/org.matrix.simplified_msc3575/sync`)],
])('leaves %s alone', async (_name, request) => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const { base, calls } = capturing();

  await withUploadDeadline(base)(request);

  expect(calls[0]?.[0]).toBe(request);
  expect(timeout).not.toHaveBeenCalled();
});
