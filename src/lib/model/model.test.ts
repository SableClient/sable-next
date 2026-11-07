import { expect, test, vi } from 'vitest';

const loadWasm = vi.hoisted(() => vi.fn());
vi.mock('#src/generated/wasm/sable_model.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: loadWasm,
}));

vi.mock('#src/generated/wasm/sable_model_bg.wasm?url', () => ({
  default: 'https://app.test/model.wasm',
}));

test.each([
  [
    'an HTML page with a 200',
    new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    200,
  ],
  ['a 404', new Response('Not found', { status: 404 }), 404],
])('refuses %s in place of the wasm before compiling it', async (_name, response, status) => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  loadWasm.mockClear();
  const { loadModel, ModelAssetError } = await import('./model.js');
  loadWasm.mockImplementationOnce(
    async ({ module_or_path }: { module_or_path: Promise<Response> }) => {
      await module_or_path;
    }
  );

  const error: unknown = await loadModel().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(ModelAssetError);
  expect(error).toMatchObject({ status });
  vi.unstubAllGlobals();
});

test('a failed load is retried by the next caller rather than kept', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('wasm')));
  const { loadModel } = await import('./model.js');
  loadWasm.mockRejectedValueOnce(new Error('Load failed')).mockResolvedValueOnce({});

  await expect(loadModel()).rejects.toThrow('Load failed');
  await expect(loadModel()).resolves.toEqual({});
  await expect(loadModel()).resolves.toEqual({});
  expect(loadWasm).toHaveBeenCalledTimes(2);
});
