import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const CALLBACK_PATH = '/callback';

export class AuthLoopback {
  private server: Server | null = null;

  constructor(private readonly onCallback: (url: string) => void) {}

  async start(): Promise<string> {
    this.close();
    let origin = '';
    const server = createServer((request, response) => {
      const url = URL.parse(request.url ?? '/', origin);
      if (
        !url ||
        this.server !== server ||
        request.method !== 'GET' ||
        url.origin !== origin ||
        url.pathname !== CALLBACK_PATH
      ) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end('You can close this tab and return to Sable.');
      this.close();
      this.onCallback(url.href);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return `${origin}${CALLBACK_PATH}`;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }
}
