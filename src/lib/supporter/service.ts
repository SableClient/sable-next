import { isRecord } from '#lib/guards.js';

import { parseAwards, type Award } from './award.js';

export interface OpenIdToken {
  access_token: string;
  matrix_server_name: string;
}

export class SupporterServiceError extends Error {
  constructor(readonly status: number) {
    super(`awards service answered ${status}`);
  }
}

async function request(serviceUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${serviceUrl}${path}`, init);
  if (!response.ok) throw new SupporterServiceError(response.status);
  return response.json();
}

function postToken(serviceUrl: string, path: string, token: OpenIdToken): Promise<unknown> {
  return request(serviceUrl, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token),
  });
}

export async function startVerification(serviceUrl: string, token: OpenIdToken): Promise<string> {
  const body = await postToken(serviceUrl, '/oauth/start', token);
  const url = isRecord(body) ? body.url : null;
  if (typeof url !== 'string') throw new SupporterServiceError(502);
  return url;
}

export async function fetchAwards(serviceUrl: string, userId: string): Promise<Award[]> {
  const body = await request(serviceUrl, `/awards?user_id=${encodeURIComponent(userId)}`);
  return parseAwards(JSON.stringify(body));
}

export async function refreshAwards(
  serviceUrl: string,
  token: OpenIdToken
): Promise<Award[] | null> {
  try {
    return parseAwards(JSON.stringify(await postToken(serviceUrl, '/refresh', token)));
  } catch (error) {
    if (error instanceof SupporterServiceError && error.status === 404) return null;
    throw error;
  }
}
