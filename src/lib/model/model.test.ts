import { expect, test, vi } from 'vitest';

const loadWasm = vi.hoisted(() => vi.fn());
vi.mock('#src/generated/wasm/sable_model.js', () => ({ default: loadWasm }));

test('a failed load is retried by the next caller rather than kept', async () => {
  const { loadModel } = await import('./model.js');
  loadWasm.mockRejectedValueOnce(new Error('Load failed')).mockResolvedValueOnce({});

  await expect(loadModel()).rejects.toThrow('Load failed');
  await expect(loadModel()).resolves.toEqual({});
  await expect(loadModel()).resolves.toEqual({});
  expect(loadWasm).toHaveBeenCalledTimes(2);
});
