/// <reference lib="webworker" />

import init, { serve } from '#src/generated/wasm/sable_search_worker.js';

declare const self: DedicatedWorkerGlobalScope;

/** Each message hands over a channel from the core, which gets the database for as long as it lives. */
self.onmessage = ({ data }: MessageEvent<{ port: MessagePort }>) => {
  void init().then(() => serve(data.port));
};
