import { expect, test } from 'vitest';
import { wasmDebugIds } from './wasm-debug';

const header = [0, 97, 115, 109, 1, 0, 0, 0];

test('reads the same code and debug ids as Sentry from the build_id section', () => {
  const name = [...new TextEncoder().encode('build_id')];
  const id = [16, ...Array.from({ length: 16 }, (_, index) => index * 17)];
  const module = new WebAssembly.Module(
    new Uint8Array([...header, 0, 1 + name.length + id.length, name.length, ...name, ...id])
  );

  expect(wasmDebugIds(module)).toEqual({
    code_id: '1000112233445566778899aabbccddeeff',
    debug_id: '1000112233445566778899aabbccddee0',
  });
});

test('development modules without a build id have no debug image', () => {
  expect(wasmDebugIds(new WebAssembly.Module(new Uint8Array(header)))).toBeUndefined();
});
