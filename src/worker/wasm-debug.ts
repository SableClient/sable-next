/** Match @sentry/wasm's IDs, including the build_id section's length prefix. */
export function wasmDebugIds(
  module: WebAssembly.Module
): { code_id: string; debug_id: string } | undefined {
  const section = WebAssembly.Module.customSections(module, 'build_id').at(0);
  if (!section) return undefined;
  const codeId = Array.from(new Uint8Array(section), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return { code_id: codeId, debug_id: `${codeId.padEnd(32, '0').slice(0, 32)}0` };
}
