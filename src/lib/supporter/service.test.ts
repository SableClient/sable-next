import { afterEach, describe, expect, test, vi } from 'vitest';

import { VALID } from './fixtures.js';
import { fetchAwards, refreshAwards, startVerification, SupporterServiceError } from './service.js';

const token = { access_token: 'tok', matrix_server_name: 'example.org' };
const serviceUrl = 'https://awards.test';

function respond(status: number, body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startVerification', () => {
  test('posts the OpenID token and returns the authorize url', async () => {
    const fetchMock = respond(200, { url: 'https://opencollective.com/oauth/authorize?state=s' });
    vi.stubGlobal('fetch', fetchMock);

    expect(await startVerification(serviceUrl, token)).toBe(
      'https://opencollective.com/oauth/authorize?state=s'
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://awards.test/oauth/start');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify(token) });
  });

  test('rejects an answer without a url', async () => {
    vi.stubGlobal('fetch', respond(200, {}));
    await expect(startVerification(serviceUrl, token)).rejects.toBeInstanceOf(
      SupporterServiceError
    );
  });

  test('surfaces a refusal as an error with its status', async () => {
    vi.stubGlobal('fetch', respond(401, { error: 'no' }));
    await expect(startVerification(serviceUrl, token)).rejects.toMatchObject({ status: 401 });
  });
});

describe('fetchAwards', () => {
  test('encodes the user id and keeps only well-formed awards', async () => {
    const fetchMock = respond(200, [VALID, { signed: {} }]);
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchAwards(serviceUrl, '@alice:example.org')).toEqual([VALID]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://awards.test/awards?user_id=%40alice%3Aexample.org'
    );
  });
});

describe('refreshAwards', () => {
  test('returns the new awards', async () => {
    vi.stubGlobal('fetch', respond(200, [VALID]));
    expect(await refreshAwards(serviceUrl, token)).toEqual([VALID]);
  });

  test('returns null when the account is no longer linked', async () => {
    vi.stubGlobal('fetch', respond(404, { error: 'none' }));
    expect(await refreshAwards(serviceUrl, token)).toBeNull();
  });

  test('rethrows any other failure', async () => {
    vi.stubGlobal('fetch', respond(502, { error: 'down' }));
    await expect(refreshAwards(serviceUrl, token)).rejects.toMatchObject({ status: 502 });
  });
});
