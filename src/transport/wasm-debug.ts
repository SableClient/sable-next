import type { Event } from '@sentry/sveltekit';
import type { WasmDebugImage } from '../worker/protocol';

/** Sentry needs native instruction addresses relative to the wasm image, even for JS-visible frames. */
export function applyWasmDebugImage(event: Event, image: WasmDebugImage): Event {
  const images = event.debug_meta?.images ?? [];
  for (const exception of event.exception?.values ?? []) {
    for (const frame of exception.stacktrace?.frames ?? []) {
      const match = /([^()]+):wasm-function\[\d+\]:(0x[\da-f]+)$/i.exec(frame.filename ?? '');
      if (!match) continue;
      const [, filename, address] = match;
      if (filename !== image.code_file && !filename.startsWith('wasm://wasm/')) continue;
      frame.filename = image.code_file;
      frame.instruction_addr = address;
      frame.platform = 'native';
      frame.addr_mode = `rel:${images.length}`;
    }
  }
  event.debug_meta = { ...event.debug_meta, images: [...images, image] };
  return event;
}
