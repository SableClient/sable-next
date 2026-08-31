import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

type Fault = {
  pattern: RegExp;
  status: number;
  body?: unknown;
  times: number;
};

type Delay = {
  pattern: RegExp;
  ms: number;
  times: number;
};

type Stub = {
  pattern: RegExp;
  status: number;
  body: unknown;
  times: number;
};

type Discovery = Record<string, { base_url?: string } | undefined>;

function parseJson(payload: string): Discovery | undefined {
  try {
    return JSON.parse(payload) as Discovery;
  } catch {
    return undefined;
  }
}

export class HomeserverProxy {
  private readonly log: string[] = [];
  private readonly faults: Fault[] = [];
  private readonly delays: Delay[] = [];
  private readonly stubs: Stub[] = [];

  constructor(
    private readonly server: Server,
    readonly baseUrl: string,
    private readonly upstream: URL
  ) {}

  static async start(upstreamBaseUrl: string): Promise<HomeserverProxy> {
    const upstream = new URL(upstreamBaseUrl);
    const route: { onRequest?: (incoming: IncomingMessage, outgoing: ServerResponse) => void } = {};
    const server = createServer((incoming, outgoing) => {
      route.onRequest?.(incoming, outgoing);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const proxy = new HomeserverProxy(server, `http://127.0.0.1:${String(port)}`, upstream);
    route.onRequest = (incoming, outgoing) => void proxy.handle(incoming, outgoing);
    return proxy;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, 'close');
  }

  fail(
    pattern: RegExp,
    status = 500,
    { times = 1, body }: { times?: number; body?: unknown } = {}
  ) {
    this.faults.push({ pattern, status, body, times });
  }

  delay(pattern: RegExp, ms: number, { times = 1 }: { times?: number } = {}) {
    this.delays.push({ pattern, ms, times });
  }

  respond(
    pattern: RegExp,
    body: unknown,
    { status = 200, times = 1 }: { status?: number; times?: number } = {}
  ) {
    this.stubs.push({ pattern, status, body, times });
  }

  count(pattern: RegExp): number {
    return this.log.filter((entry) => pattern.test(entry)).length;
  }

  clearRequests(): void {
    this.log.length = 0;
  }

  reset(): void {
    this.log.length = 0;
    this.faults.length = 0;
    this.delays.length = 0;
    this.stubs.length = 0;
  }

  private take<T extends { pattern: RegExp; times: number }>(rules: T[], entry: string): T | null {
    const index = rules.findIndex((rule) => rule.pattern.test(entry));
    if (index === -1) return null;
    const rule = rules[index];
    rule.times -= 1;
    if (rule.times <= 0) rules.splice(index, 1);
    return rule;
  }

  private async handle(incoming: IncomingMessage, outgoing: ServerResponse) {
    const path = incoming.url ?? '/';
    const entry = `${incoming.method ?? 'GET'} ${path}`;
    this.log.push(entry);

    const delay = this.take(this.delays, entry);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay.ms));

    const fault = this.take(this.faults, entry);
    if (fault) {
      this.answer(
        outgoing,
        fault.status,
        fault.body ?? {
          errcode: 'M_UNKNOWN',
          error: 'proxy fault',
        }
      );
      return;
    }

    const stub = this.take(this.stubs, entry);
    if (stub) {
      this.answer(outgoing, stub.status, stub.body);
      return;
    }

    const body: Buffer[] = [];
    for await (const chunk of incoming) body.push(chunk as Buffer);

    const headers = { ...incoming.headers, host: this.upstream.host };
    const forwarded = httpRequest(
      {
        hostname: this.upstream.hostname,
        port: this.upstream.port,
        method: incoming.method,
        path,
        headers,
      },
      (response) => {
        if (path.startsWith('/.well-known/matrix/client')) {
          void this.rewriteWellKnown(response, outgoing);
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      }
    );
    forwarded.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    forwarded.end(Buffer.concat(body));
  }

  private answer(outgoing: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    outgoing.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'content-length': Buffer.byteLength(payload),
    });
    outgoing.end(payload);
  }

  private async rewriteWellKnown(
    response: IncomingMessage,
    outgoing: ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    let payload = Buffer.concat(chunks).toString('utf8');
    const parsed = parseJson(payload);
    const discovered = parsed?.['m.homeserver'];
    if (parsed && discovered) {
      discovered.base_url = this.baseUrl;
      payload = JSON.stringify(parsed);
    }
    outgoing.writeHead(response.statusCode ?? 200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'content-length': Buffer.byteLength(payload),
    });
    outgoing.end(payload);
  }
}
