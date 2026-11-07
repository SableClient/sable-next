const BUILD_OUTPUT = '/_app/';

// Runs only for a non-navigation request that matched no asset. Without it the SPA
// fallback answers a removed chunk or wasm module with index.html and a 200.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith(BUILD_OUTPUT)) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
