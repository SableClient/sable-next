export type PageFetchInit = {
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  mode: RequestMode;
  credentials: RequestCredentials;
  cache: RequestCache;
  redirect: RequestRedirect;
  referrerPolicy: ReferrerPolicy;
  integrity: string;
};

export type PageFetchRequest = { probe: string } | { fetch: PageFetchInit };

export type PageFetchResponse = {
  url: string;
  redirected: boolean;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
};

export type PageFetchReply =
  | { reachable: boolean }
  | { response: PageFetchResponse }
  | { failed: string };

export type PageFetcher = (
  request: PageFetchRequest,
  transfer: Transferable[],
  signal: AbortSignal
) => Promise<PageFetchReply | null>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const PROBE_TIMEOUT_MS = 60_000;
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const listening = new AbortController();
  const aborted = new Promise<undefined>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve(undefined);
      },
      { once: true, signal: listening.signal }
    );
  });
  try {
    const settled = await Promise.race([promise.then((value) => ({ value })), aborted]);
    if (settled) return settled.value;
    signal.throwIfAborted();
    return await promise;
  } finally {
    listening.abort();
  }
}

function probeInit(signal?: AbortSignal): RequestInit {
  return { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal };
}

async function toPageInit(request: Request): Promise<PageFetchInit> {
  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers],
    body: request.body === null ? null : await request.arrayBuffer(),
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
  };
}

function fromPageInit({ url, body, ...init }: PageFetchInit, signal: AbortSignal): Request {
  return new Request(url, {
    ...init,
    body: BODYLESS_METHODS.has(init.method) ? null : body,
    signal,
  });
}

function toResponse(reply: PageFetchResponse): Response {
  const response = new Response(NULL_BODY_STATUSES.has(reply.status) ? null : reply.body, {
    status: reply.status,
    statusText: reply.statusText,
    headers: reply.headers,
  });
  Object.defineProperties(response, {
    url: { value: reply.url },
    redirected: { value: reply.redirected },
  });
  return response;
}

export function withPageFetchFallback(
  direct: typeof fetch,
  pageFetch: PageFetcher,
  ownOrigin: string
): typeof fetch {
  const routed = new Set<string>();
  const checks = new Map<string, Promise<boolean>>();

  function blockedHere(origin: string): Promise<boolean> {
    let check = checks.get(origin);
    if (check) return check;
    check = (async () => {
      try {
        await direct(`${origin}/`, probeInit(AbortSignal.timeout(PROBE_TIMEOUT_MS)));
        return false;
      } catch {
        const reply = await pageFetch(
          { probe: `${origin}/` },
          [],
          AbortSignal.timeout(PROBE_TIMEOUT_MS)
        );
        return reply !== null && 'reachable' in reply && reply.reachable;
      }
    })()
      .catch(() => false)
      .finally(() => {
        checks.delete(origin);
      });
    checks.set(origin, check);
    return check;
  }

  async function throughPage(request: Request): Promise<Response> {
    const init = await toPageInit(request);
    const reply = await pageFetch(
      { fetch: init },
      init.body === null ? [] : [init.body],
      request.signal
    );
    if (reply === null) return direct(fromPageInit(init, request.signal));
    if ('response' in reply) return toResponse(reply.response);
    throw new TypeError('failed' in reply ? reply.failed : 'NetworkError');
  }

  return async (input, init) => {
    const request = new Request(input, init);
    const origin = httpOrigin(request.url);
    if (origin === null || origin === ownOrigin) return direct(request);
    if (routed.has(origin)) return throughPage(request);

    const spare = request.body === null ? request : request.clone();
    try {
      return await direct(request);
    } catch (error) {
      if (!(error instanceof TypeError) || request.signal.aborted) throw error;
      if (!(await abortable(blockedHere(origin), request.signal))) throw error;
      routed.add(origin);
      return throughPage(spare);
    }
  };
}

export async function requestThroughPage(
  post: (request: PageFetchRequest, transfer: Transferable[]) => void,
  request: PageFetchRequest,
  transfer: Transferable[],
  signal: AbortSignal
): Promise<PageFetchReply> {
  signal.throwIfAborted();
  const channel = new MessageChannel();
  const reply = new Promise<PageFetchReply>((resolve) => {
    channel.port1.onmessage = ({ data }: MessageEvent<PageFetchReply>) => {
      resolve(data);
    };
  });
  try {
    post(request, [channel.port2, ...transfer]);
    return await abortable(reply, signal);
  } catch (error) {
    if (signal.aborted) channel.port1.postMessage('abort');
    throw error;
  } finally {
    channel.port1.close();
  }
}

async function answer(
  request: PageFetchRequest,
  signal: AbortSignal
): Promise<[PageFetchReply, Transferable[]]> {
  if ('probe' in request) {
    if (httpOrigin(request.probe) === null) return [{ reachable: false }, []];
    try {
      await fetch(request.probe, probeInit(signal));
      return [{ reachable: true }, []];
    } catch {
      return [{ reachable: false }, []];
    }
  }

  if (httpOrigin(request.fetch.url) === null) return [{ failed: 'unsupported URL' }, []];
  try {
    const response = await fetch(fromPageInit(request.fetch, signal));
    if (response.status < 200 || response.status > 599) {
      return [{ failed: `unreadable ${response.type} response` }, []];
    }
    const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
    return [
      {
        response: {
          url: response.url,
          redirected: response.redirected,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body,
        },
      },
      body === null ? [] : [body],
    ];
  } catch (error) {
    return [{ failed: error instanceof Error ? error.name : 'NetworkError' }, []];
  }
}

export function servePageFetch(request: PageFetchRequest, port: MessagePort): void {
  const controller = new AbortController();
  port.onmessage = () => {
    controller.abort();
    port.close();
  };
  void answer(request, controller.signal)
    .then(([reply, transfer]) => {
      if (!controller.signal.aborted) port.postMessage(reply, transfer);
    })
    .finally(() => {
      port.close();
    });
}
