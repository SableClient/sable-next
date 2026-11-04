import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, relative, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

let server: Server | undefined;
let origin: string;
const directory = resolve('dist');
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function emulateMissingContainerQueries(): void {
  const supports = CSS.supports.bind(CSS);
  CSS.supports = (property: string, value?: string) =>
    property === 'container-type'
      ? false
      : value === undefined
        ? supports(property)
        : supports(property, value);
  Object.defineProperty(HTMLHtmlElement.prototype, 'style', {
    get(this: HTMLHtmlElement) {
      const style = Reflect.get(HTMLElement.prototype, 'style', this);
      return new Proxy(style, {
        has: (target, key) => key !== 'container' && Reflect.has(target, key),
        get: (target, key) => {
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? (value.bind(target) as unknown) : value;
        },
      });
    },
  });
}

test.beforeAll(async () => {
  const headers = await readFile(resolve(directory, '_headers'), 'utf8');
  const policy = /^\s+Content-Security-Policy: (.+)$/m.exec(headers)?.[1];
  if (!policy) throw new Error('Build the app with CSP headers before running this test');
  server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/__csp_control') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><body>control</body>');
        return;
      }
      if (pathname === '/__csp_parent') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<iframe src="/__csp_probe"></iframe>');
        return;
      }
      if (pathname === '/__csp_widget') {
        response.setHeader('Content-Type', 'text/html');
        response.end('widget');
        return;
      }
      response.setHeader('Content-Security-Policy', policy);
      if (pathname === '/__csp_probe') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<button onclick="document.body.dataset.injected=1">Click</button>');
        return;
      }
      let file = resolve(directory, `.${decodeURIComponent(pathname)}`);
      if (relative(directory, file).startsWith('..')) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) file = resolve(directory, 'index.html');
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  const listener = server;
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  origin = `http://127.0.0.1:${String(address.port)}`;
});

test.afterAll(async () => {
  const listener = server;
  if (!listener) return;
  listener.closeAllConnections();
  await new Promise<void>((done) =>
    listener.close(() => {
      done();
    })
  );
});

test('production bootstrap keeps custom themes and font preferences', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'sable-preferences',
      JSON.stringify({ theme: 'dark', fontFamily: 'Arial' })
    );
    localStorage.setItem(
      'sable-custom-themes',
      JSON.stringify({
        themes: [
          { id: 'csp', name: 'CSP', kind: 'dark', css: 'body.remote-theme{--csp-theme:loaded}' },
        ],
        tweaks: [],
        darkThemeId: 'csp',
        lightThemeId: null,
        enabledTweakIds: [],
      })
    );
  });
  await page.goto(origin);
  await expect(page.locator('body')).toHaveCSS('--csp-theme', 'loaded');
  await expect(page.locator('body')).toHaveCSS('font-family', /Arial/);
});

test('custom CSS can load external styles and fonts', async ({ page }) => {
  const require = createRequire(import.meta.url);
  const font = await readFile(
    require.resolve('@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2')
  );
  await page.route('https://fonts.csp.test/font.woff2', (route) =>
    route.fulfill({
      contentType: 'font/woff2',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: font,
    })
  );
  await page.route('https://themes.csp.test/theme.css', (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: '@font-face{font-family:CspFont;src:url(https://fonts.csp.test/font.woff2)}body{--csp-external-theme:loaded}',
    })
  );
  await page.goto(`${origin}/__csp_probe`);
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '@import url(https://themes.csp.test/theme.css);';
    document.head.append(style);
  });
  await expect(page.locator('body')).toHaveCSS('--csp-external-theme', 'loaded');
  const fonts = await page.evaluate(async () => (await document.fonts.load('16px CspFont')).length);
  expect(fonts).toBeGreaterThan(0);
});

test('styles load without native container queries', async ({ page }) => {
  await page.addInitScript(emulateMissingContainerQueries);
  await page.route(`${origin}/__csp_container.css`, (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: '.csp-container{container-type:inline-size;width:200px}.csp-child{display:grid;color:rgb(4,5,6)}@container (min-width:100px){.csp-child{color:rgb(1,2,3)}}',
    })
  );
  await page.goto(origin);
  await expect(page.locator('link[rel="stylesheet"]').first()).toHaveAttribute('href', /^blob:/);
  await expect(page.locator('body')).toHaveCSS('margin', '0px');
  await expect(page.locator('body')).toHaveCSS('font-family', /Nunito/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="csp-container"><div class="csp-child"></div></div>'
    );
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/__csp_container.css';
    document.head.append(link);
  });
  const child = page.locator('.csp-child');
  await expect(child).toHaveCSS('display', 'grid');
  await expect(child).toHaveCSS('color', 'rgb(1, 2, 3)');
  await page.locator('.csp-container').evaluate((container) => {
    container.style.width = '50px';
  });
  await expect(child).toHaveCSS('color', 'rgb(4, 5, 6)');
});

test('highlighter grammar modules can load from the scoped CDN', async ({ page }) => {
  const url = 'https://cdn.jsdelivr.net/npm/@arborium/rust@0.0.0/grammar.js';
  await page.route(url, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'export const language = "rust";',
    })
  );
  await page.goto(`${origin}/__csp_probe`);
  const language = await page.evaluate(async (url) => {
    const grammar = (await import(url)) as { language: string };
    return grammar.language;
  }, url);
  expect(language).toBe('rust');
});

test('Wasm, blob workers and audio worklets remain available', async ({ page }) => {
  await page.goto(`${origin}/__csp_probe`);
  const result = await page.evaluate(async () => {
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const workerUrl = URL.createObjectURL(
      new Blob(['postMessage("worker-ready")'], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    const message = await new Promise<string>((done, reject) => {
      worker.onmessage = (event: MessageEvent<string>) => {
        done(event.data);
      };
      worker.onerror = reject;
    });
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    const audio = new AudioContext();
    const workletUrl = URL.createObjectURL(
      new Blob(
        [
          'registerProcessor("csp-probe", class extends AudioWorkletProcessor { process() { return false; } });',
        ],
        { type: 'text/javascript' }
      )
    );
    try {
      await audio.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(audio, 'csp-probe');
      node.disconnect();
    } finally {
      URL.revokeObjectURL(workletUrl);
      await audio.close();
    }
    return message;
  });
  expect(result).toBe('worker-ready');
});

test('notification worker retains permissions and responds after startup', async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === 'chromium') await context.grantPermissions(['notifications']);
  await page.goto(`${origin}/__csp_control`);
  const baseline = await page.evaluate(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  );
  await page.goto(`${origin}/__csp_probe`);
  expect(
    await page.evaluate(() =>
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
    )
  ).toBe(baseline);
  const result = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/service-worker.js', { type: 'module' });
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) throw new Error('Notification worker is missing');
    if (worker.state !== 'activated') {
      await new Promise<void>((done) => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') done();
        });
      });
    }
    const version = await new Promise<unknown>((done) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        channel.port1.close();
        done(event.data);
      };
      worker.postMessage({ type: 'sable:version' }, [channel.port2]);
    });
    let count: number | null = null;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      await registration.showNotification('CSP test', { tag: 'csp-test' });
      const notifications = await registration.getNotifications({ tag: 'csp-test' });
      for (const notification of notifications) notification.close();
      count = notifications.length;
    }
    await registration.unregister();
    return { state: worker.state, count, version };
  });
  expect(result.state).toBe('activated');
  expect(typeof result.version).toBe('string');
  if (baseline === 'granted') expect(result.count).toBe(1);
});

test('widget frames are allowed while framing the app is blocked', async ({ page }) => {
  await page.goto(`${origin}/__csp_probe`);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/__csp_widget';
    document.body.append(frame);
  });
  await expect(page.frameLocator('iframe').locator('body')).toHaveText('widget');
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('frame-ancestors')) violations.push(message.text());
  });
  await page.goto(`${origin}/__csp_parent`);
  await expect.poll(() => violations.length).toBeGreaterThan(0);
});

test('injected inline handlers, external scripts and base URLs are blocked', async ({ page }) => {
  await page.goto(`${origin}/__csp_probe`);
  await page.getByRole('button', { name: 'Click' }).click();
  expect(await page.locator('body').getAttribute('data-injected')).toBeNull();
  const result = await page.evaluate(async () => {
    const script = document.createElement('script');
    script.src = 'https://other.csp.test/injected.js';
    const blocked = new Promise<boolean>((done) => {
      script.onerror = () => {
        done(true);
      };
      script.onload = () => {
        done(false);
      };
    });
    document.body.append(script);
    const isBlocked = await blocked;
    const base = document.createElement('base');
    base.href = 'https://other.csp.test/';
    document.head.append(base);
    return { isBlocked, base: document.baseURI, injected: document.body.dataset.injected };
  });
  expect(result).toEqual({ isBlocked: true, base: `${origin}/__csp_probe`, injected: undefined });
});
