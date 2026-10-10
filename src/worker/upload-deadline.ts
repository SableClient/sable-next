const MIN_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const UPLOAD_BYTES_PER_SECOND = 125_000;
const UPLOAD_PATH = /^\/_matrix\/media\/[^/]+\/upload(\/|$)/;

type Fetch = typeof fetch;

function isUpload(request: Request): boolean {
  if (request.method !== 'POST' && request.method !== 'PUT') return false;
  return UPLOAD_PATH.test(new URL(request.url).pathname);
}

export function uploadTimeoutMs(bytes: number): number {
  return Math.max(Math.floor(bytes / UPLOAD_BYTES_PER_SECOND) * 1000, MIN_UPLOAD_TIMEOUT_MS);
}

export function withUploadDeadline(base: Fetch): Fetch {
  return async (input, init) => {
    if (!(input instanceof Request) || init !== undefined || !isUpload(input)) {
      return base(input, init);
    }
    const { size } = await input.clone().blob();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(uploadTimeoutMs(size))]);
    return base(new Request(input, { signal }));
  };
}

export function installUploadDeadline(scope: { fetch: Fetch }): void {
  scope.fetch = withUploadDeadline(scope.fetch.bind(scope));
}
