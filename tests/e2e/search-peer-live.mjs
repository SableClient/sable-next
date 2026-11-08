import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';

const pending = new Map();
const pages = [];
const browsers = [];
let sequence = 0;
let stopping = false;
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if ('event' in message) {
    if (stopping) return;
    void pages[message.side].evaluate((event) => window.peerEvent(event), message.event);
  } else {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if ('error' in message) request.reject(new Error(message.error));
    else request.resolve(message.ok);
  }
});

function call(side, method, params = {}) {
  const id = sequence++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.stdout.write(`${JSON.stringify({ id, side, method, params })}\n`);
  });
}

const options = {
  disk_budget_mb: 100,
  crawler: false,
  sharing: true,
  unmetered_only: true,
  server_search: false,
  foreground: true,
  tuning: {
    crawl_pause_ms: 3000,
    trickle_pause_ms: 10000,
    flush_interval_secs: 60,
    batch: 50,
    base_events: 20000,
    max_events: 50000,
  },
};

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  resolve: {
    alias: {
      '#src': fileURLToPath(new URL('../../src', import.meta.url)),
      '#lib': fileURLToPath(new URL('../../src/lib', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', port: 0, ws: false },
});
server.middlewares.use((request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Peer test</title>');
});
const timeout = setTimeout(() => {
  console.error('Search transfer timed out');
  process.exit(1);
}, 60_000);
try {
  await server.listen();
  const { port } = server.httpServer.address();
  for (const [side, engine] of [chromium, webkit].entries()) {
    const browser = await engine.launch({ headless: true });
    browsers.push(browser);
    const page = await browser.newPage();
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.exposeFunction('peerCall', (method, params) => call(side, method, params));
    await page.exposeFunction('peerData', (sessionId, frame) =>
      call(side, 'rtc_data', { session_id: sessionId, frame })
    );
    await call(side, 'session.set_search_options', options);
    await page.evaluate(async (side) => {
      const { loadModel } = await import('/src/lib/model/model.ts');
      await loadModel();
      const { watchSearchPeers } = await import('/src/lib/search/search-peer.ts');
      window.largestPeerFrame = 0;
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (data) {
        window.largestPeerFrame = Math.max(
          window.largestPeerFrame,
          typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength
        );
        return send.call(this, data);
      };
      const listeners = new Set();
      window.peerEvent = (event) => listeners.forEach((listener) => listener(event));
      const route = (method) => (params) => window.peerCall(method, params);
      const rpc = {
        search: {
          peerStart: route('search.peer_start'),
        },
        rtc: { signal: route('rtc.signal'), close: route('rtc.close') },
        calls: { turnServer: route('calls.turn_server') },
      };
      window.stopPeers = watchSearchPeers(
        {
          session: { account_id: `device-${side}` },
          rpc,
          rtcData: async (sessionId, frame) =>
            new Uint8Array(await window.peerData(sessionId, Array.from(frame))),
          subscribeEvents(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        { unmeteredOnly: true, stunServers: [] }
      );
    }, side);
  }
  await call(0, 'search.peer_start');
  await call(1, 'search.peer_find');
  for (;;) {
    const result = await call(1, 'search.messages', { query: 'needle', limit: 100, offset: 0 });
    if (result.hits.length === 60) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (;;) {
    const metrics = await Promise.all([0, 1].map((side) => call(side, 'search.metrics')));
    if (metrics.every(({ sharing }) => sharing.state === 'idle')) {
      assert.equal(metrics[1].sharing.outcome, 'completed');
      assert.equal(metrics[1].sharing.rooms_copied, 1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    Math.max(
      ...(await Promise.all(pages.map((page) => page.evaluate(() => window.largestPeerFrame))))
    ),
    16 * 1024
  );
} finally {
  stopping = true;
  clearTimeout(timeout);
  await Promise.all(pages.map((page) => page.evaluate(() => window.stopPeers?.()).catch(() => {})));
  await Promise.all(
    pages.map((_, side) =>
      call(side, 'session.set_search_options', { ...options, foreground: false })
    )
  );
  await Promise.all(browsers.map((browser) => browser.close()));
  await server.close();
  while (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  input.close();
}
