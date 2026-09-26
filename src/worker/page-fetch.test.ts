import { afterEach, expect, test, vi } from 'vitest';

import {
  requestThroughPage,
  servePageFetch,
  withPageFetchFallback,
  type PageFetcher,
  type PageFetchReply,
  type PageFetchRequest,
} from './page-fetch';

const OWN = 'https://app.sable.test';
const HOMESERVER = 'https://matrix.lan';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function grantLocalNetwork(state: PermissionState = 'granted'): void {
  vi.stubGlobal('navigator', {
    permissions: { query: () => Promise.resolve({ state }) },
  });
}

function blockedDirect(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(() =>
    Promise.reject(new TypeError('NetworkError when attempting to fetch resource.'))
  );
}

function pageReply(
  answer: (request: PageFetchRequest) => PageFetchReply | null
): ReturnType<typeof vi.fn<PageFetcher>> {
  return vi.fn<PageFetcher>((request) => Promise.resolve(answer(request)));
}

const reachablePage = (request: PageFetchRequest): PageFetchReply =>
  'probe' in request
    ? { reachable: true }
    : {
        response: {
          url: request.fetch.url,
          redirected: false,
          status: 200,
          statusText: 'OK',
          headers: [['content-type', 'application/json']],
          body: new TextEncoder().encode('{"ok":true}').buffer,
        },
      };

test('a request the worker can make never touches the page', async () => {
  const direct = vi.fn<typeof fetch>(() => Promise.resolve(new Response('direct')));
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);

  const response = await fetch(`${HOMESERVER}/_matrix/client/versions`);

  expect(await response.text()).toBe('direct');
  expect(page).not.toHaveBeenCalled();
});

test('a request blocked in the worker is made by the page, body and headers intact', async () => {
  const direct = blockedDirect();
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);

  const response = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: '{"type":"m.login.password"}',
  });

  expect(response.status).toBe(200);
  expect(response.url).toBe(`${HOMESERVER}/_matrix/client/v3/login`);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({ ok: true });

  const sent = page.mock.calls.find(([request]) => 'fetch' in request)?.[0];
  expect(sent).toBeDefined();
  if (!sent || !('fetch' in sent)) return;
  expect(sent.fetch.method).toBe('POST');
  expect(sent.fetch.headers).toContainEqual(['authorization', 'Bearer token']);
  expect(new TextDecoder().decode(sent.fetch.body ?? new ArrayBuffer(0))).toBe(
    '{"type":"m.login.password"}'
  );
});

test('once an origin is known to be blocked, its requests go to the page first', async () => {
  const direct = blockedDirect();
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);

  await fetch(`${HOMESERVER}/_matrix/client/versions`);
  const directCalls = direct.mock.calls.length;
  await fetch(`${HOMESERVER}/_matrix/client/v3/sync`);

  expect(direct.mock.calls.length).toBe(directCalls);
  expect(page.mock.calls.filter(([request]) => 'probe' in request)).toHaveLength(1);
});

test('a failure the worker can probe past is not retried, so nothing is sent twice', async () => {
  const direct = vi.fn<typeof fetch>((input) =>
    typeof input === 'string'
      ? Promise.resolve(new Response(null, { status: 200 }))
      : Promise.reject(new TypeError('connection reset'))
  );
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);

  await expect(
    fetch(`${HOMESERVER}/_matrix/client/v3/rooms/!r/send/m.room.message/1`, { method: 'PUT' })
  ).rejects.toThrow('connection reset');
  expect(page.mock.calls.some(([request]) => 'fetch' in request)).toBe(false);
});

test('an origin the worker has reached is never handed to the page', async () => {
  let blocked = false;
  const direct = vi.fn<typeof fetch>(() =>
    blocked ? Promise.reject(new TypeError('connection reset')) : Promise.resolve(new Response())
  );
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);
  await fetch(`${HOMESERVER}/_matrix/client/v3/sync`);

  blocked = true;
  await expect(fetch(`${HOMESERVER}/_matrix/client/v3/sync`)).rejects.toThrow('connection reset');

  expect(page).not.toHaveBeenCalled();
  expect(direct).toHaveBeenCalledTimes(2);
});

test('a routed origin returns to the worker once the worker can reach it', async () => {
  vi.useFakeTimers();
  let blocked = true;
  const direct = vi.fn<typeof fetch>(() =>
    blocked ? Promise.reject(new TypeError('blocked')) : Promise.resolve(new Response('direct'))
  );
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);
  await fetch(`${HOMESERVER}/_matrix/client/versions`);

  blocked = false;
  await fetch(`${HOMESERVER}/a`);
  expect(page.mock.calls.filter(([request]) => 'fetch' in request)).toHaveLength(2);

  vi.advanceTimersByTime(60_000);
  await fetch(`${HOMESERVER}/b`);
  await vi.waitFor(async () => {
    expect(await (await fetch(`${HOMESERVER}/c`)).text()).toBe('direct');
  });
});

test('a homeserver the page cannot reach either stays a network error', async () => {
  const fetch = withPageFetchFallback(
    blockedDirect(),
    pageReply(() => ({ reachable: false })),
    OWN
  );

  await expect(fetch(`${HOMESERVER}/_matrix/client/versions`)).rejects.toBeInstanceOf(TypeError);
});

test('with no page connected the worker reports its own error', async () => {
  const fetch = withPageFetchFallback(
    blockedDirect(),
    pageReply(() => null),
    OWN
  );

  await expect(fetch(`${HOMESERVER}/_matrix/client/versions`)).rejects.toThrow('NetworkError');
});

test('a routed origin goes back to the worker when no page is left', async () => {
  let pages = true;
  let blocked = true;
  const direct = vi.fn<typeof fetch>(() =>
    blocked ? Promise.reject(new TypeError('blocked')) : Promise.resolve(new Response('direct'))
  );
  const fetch = withPageFetchFallback(
    direct,
    pageReply((request) => (pages ? reachablePage(request) : null)),
    OWN
  );
  await fetch(`${HOMESERVER}/_matrix/client/versions`);

  pages = false;
  blocked = false;
  const response = await fetch(`${HOMESERVER}/_matrix/client/v3/sync`, {
    method: 'POST',
    body: 'payload',
  });

  expect(await response.text()).toBe('direct');
  const retried = direct.mock.calls.at(-1)?.[0];
  expect(retried).toBeInstanceOf(Request);
  expect(await (retried as Request).text()).toBe('payload');
});

test('the app origin and non-http URLs are never routed', async () => {
  const direct = blockedDirect();
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(direct, page, OWN);

  await expect(fetch(`${OWN}/sable_wasm_bg.wasm`)).rejects.toBeInstanceOf(TypeError);
  await expect(fetch('data:text/plain,x')).rejects.toBeInstanceOf(TypeError);
  expect(page).not.toHaveBeenCalled();
});

test('concurrent failures to one origin share a single probe', async () => {
  const page = pageReply(reachablePage);
  const fetch = withPageFetchFallback(blockedDirect(), page, OWN);

  await Promise.all([fetch(`${HOMESERVER}/a`), fetch(`${HOMESERVER}/b`), fetch(`${HOMESERVER}/c`)]);

  expect(page.mock.calls.filter(([request]) => 'probe' in request)).toHaveLength(1);
});

test('a request aborted while the page works rejects with the abort reason', async () => {
  let handed = false;
  const page = vi.fn<PageFetcher>((request, transfer, signal) =>
    'probe' in request
      ? Promise.resolve({ reachable: true })
      : requestThroughPage(
          () => {
            handed = true;
          },
          request,
          transfer,
          signal
        )
  );
  const fetch = withPageFetchFallback(blockedDirect(), page, OWN);
  const controller = new AbortController();

  const pending = fetch(`${HOMESERVER}/_matrix/client/v3/sync`, { signal: controller.signal });
  const outcome = expect(pending).rejects.toBe('reqwest::errors::TimedOut');
  await vi.waitFor(() => {
    expect(handed).toBe(true);
  });
  controller.abort('reqwest::errors::TimedOut');

  await outcome;
});

test('a page failure surfaces as a network error', async () => {
  const fetch = withPageFetchFallback(
    blockedDirect(),
    pageReply((request) => ('probe' in request ? { reachable: true } : { failed: 'TypeError' })),
    OWN
  );

  await expect(fetch(`${HOMESERVER}/x`)).rejects.toBeInstanceOf(TypeError);
});

test('a bodiless status crosses without a body', async () => {
  const fetch = withPageFetchFallback(
    blockedDirect(),
    pageReply((request) =>
      'probe' in request
        ? { reachable: true }
        : {
            response: {
              url: request.fetch.url,
              redirected: false,
              status: 204,
              statusText: 'No Content',
              headers: [],
              body: null,
            },
          }
    ),
    OWN
  );

  const response = await fetch(`${HOMESERVER}/x`, { method: 'PUT', body: '{}' });

  expect(response.status).toBe(204);
  expect(response.body).toBeNull();
});

test('the page answers over the channel with the bytes it fetched', async () => {
  const pageFetch = vi.fn<typeof fetch>((input) => {
    const request = input as Request;
    return Promise.resolve(
      new Response(`echo ${request.method}`, { status: 201, headers: { 'x-echo': 'yes' } })
    );
  });
  vi.stubGlobal('fetch', pageFetch);

  const reply = await requestThroughPage(
    (request, ports) => {
      servePageFetch(request, ports.at(0) as MessagePort);
    },
    {
      fetch: {
        url: `${HOMESERVER}/x`,
        method: 'POST',
        headers: [],
        body: new TextEncoder().encode('hi').buffer,
        mode: 'cors',
        credentials: 'same-origin',
        cache: 'default',
        redirect: 'follow',
        referrerPolicy: '',
        integrity: '',
      },
    },
    [],
    new AbortController().signal
  );

  expect('response' in reply && reply.response.status).toBe(201);
  if (!('response' in reply)) return;
  expect(reply.response.headers).toContainEqual(['x-echo', 'yes']);
  expect(new TextDecoder().decode(reply.response.body ?? new ArrayBuffer(0))).toBe('echo POST');
});

test('an abort from the worker cancels the page request', async () => {
  let pageSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) => {
      pageSignal = (input as Request).signal;
      return new Promise(() => {});
    })
  );
  const controller = new AbortController();

  const reply = requestThroughPage(
    (request, ports) => {
      servePageFetch(request, ports.at(0) as MessagePort);
    },
    {
      fetch: {
        url: `${HOMESERVER}/_matrix/client/v3/sync`,
        method: 'GET',
        headers: [],
        body: null,
        mode: 'cors',
        credentials: 'same-origin',
        cache: 'default',
        redirect: 'follow',
        referrerPolicy: '',
        integrity: '',
      },
    },
    [],
    controller.signal
  );
  await vi.waitFor(() => {
    expect(pageSignal).toBeDefined();
  });
  controller.abort(new DOMException('gone', 'AbortError'));

  await expect(reply).rejects.toThrow('gone');
  await vi.waitFor(() => {
    expect(pageSignal?.aborted).toBe(true);
  });
});

test('the page probes without credentials, following redirects as no-cors requires', async () => {
  grantLocalNetwork();
  const probe = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null)));
  vi.stubGlobal('fetch', probe);

  const reply = await requestThroughPage(
    (request, ports) => {
      servePageFetch(request, ports.at(0) as MessagePort);
    },
    { probe: `${HOMESERVER}/` },
    [],
    new AbortController().signal
  );

  expect(reply).toEqual({ reachable: true });
  expect(probe).toHaveBeenCalledWith(
    `${HOMESERVER}/`,
    expect.objectContaining({ mode: 'no-cors', credentials: 'omit' })
  );
  expect(probe.mock.calls[0]?.[1]?.redirect ?? 'follow').toBe('follow');
});

test('the page does not vouch for an origin once local network access is denied', async () => {
  const probe = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null)));
  vi.stubGlobal('fetch', probe);
  const ask = () =>
    requestThroughPage(
      (request, ports) => {
        servePageFetch(request, ports.at(0) as MessagePort);
      },
      { probe: `${HOMESERVER}/` },
      [],
      new AbortController().signal
    );

  grantLocalNetwork('denied');
  expect(await ask()).toEqual({ reachable: false });
  expect(probe).not.toHaveBeenCalled();

  vi.stubGlobal('navigator', {
    permissions: { query: () => Promise.reject(new TypeError('unknown permission')) },
  });
  expect(await ask()).toEqual({ reachable: true });
  expect(probe).toHaveBeenCalledOnce();
});

test('the page refuses to fetch anything but http', async () => {
  const pageFetch = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', pageFetch);

  const reply = await requestThroughPage(
    (request, ports) => {
      servePageFetch(request, ports.at(0) as MessagePort);
    },
    { probe: 'file:///etc/passwd' },
    [],
    new AbortController().signal
  );

  expect(reply).toEqual({ reachable: false });
  expect(pageFetch).not.toHaveBeenCalled();
});

test('a GET handed over with an empty body is still made', async () => {
  const pageFetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', pageFetch);

  const reply = await requestThroughPage(
    (request, ports) => {
      servePageFetch(request, ports.at(0) as MessagePort);
    },
    {
      fetch: {
        url: `${HOMESERVER}/.well-known/matrix/client`,
        method: 'GET',
        headers: [],
        body: new ArrayBuffer(0),
        mode: 'cors',
        credentials: 'same-origin',
        cache: 'default',
        redirect: 'follow',
        referrerPolicy: '',
        integrity: '',
      },
    },
    [],
    new AbortController().signal
  );

  expect('response' in reply && reply.response.status).toBe(200);
});
