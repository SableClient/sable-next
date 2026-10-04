import { SABLE_AWARDS_URL } from '#lib/config/links.js';
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

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${SABLE_AWARDS_URL}${path}`, init);
  if (!response.ok) throw new SupporterServiceError(response.status);
  return response.json();
}

function postToken(path: string, token: OpenIdToken): Promise<unknown> {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token),
  });
}

export async function startVerification(token: OpenIdToken): Promise<string> {
  const body = await postToken('/oauth/start', token);
  const url = isRecord(body) ? body.url : null;
  if (typeof url !== 'string') throw new SupporterServiceError(502);
  return url;
}

export async function fetchAwards(userId: string): Promise<Award[]> {
  const body = await request(`/awards?user_id=${encodeURIComponent(userId)}`);
  return parseAwards(JSON.stringify(body));
}

export async function refreshAwards(token: OpenIdToken): Promise<Award[] | null> {
  try {
    return parseAwards(JSON.stringify(await postToken('/refresh', token)));
  } catch (error) {
    if (error instanceof SupporterServiceError && error.status === 404) return null;
    throw error;
  }
}
