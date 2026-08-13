import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GenericContainer, Wait } from 'testcontainers';

const IMAGE = 'ghcr.io/continuwuity/continuwuity:latest';
const CLIENT_SERVER_PORT = 8008;
const SERVER_NAME = 'test.local';
const execFileAsync = promisify(execFile);

export type TestHomeserver = {
  baseUrl: string;
  containerId: string;
};

export type RegisteredSession = {
  accessToken: string;
  userId: string;
};

export const TIMELINE_ROOM_NAME = 'Timeline fixture';
export const TIMELINE_MESSAGE_COUNT = 100;

export async function startContinuwuity(): Promise<TestHomeserver> {
  const container = await new GenericContainer(IMAGE)
    .withExposedPorts(CLIENT_SERVER_PORT)
    .withEnvironment({
      CONTINUWUITY_SERVER_NAME: SERVER_NAME,
      CONTINUWUITY_ADDRESS: '0.0.0.0',
      CONTINUWUITY_PORT: String(CLIENT_SERVER_PORT),
      CONTINUWUITY_DATABASE_PATH: '/database',
      CONTINUWUITY_ALLOW_REGISTRATION: 'true',
      CONTINUWUITY_YES_I_AM_VERY_VERY_SURE_I_WANT_AN_OPEN_REGISTRATION_SERVER_PRONE_TO_ABUSE:
        'true',
      CONTINUWUITY_FORCE_DISABLE_FIRST_RUN_MODE: 'true',
      CONTINUWUITY_ALLOW_FEDERATION: 'false',
      CONTINUWUITY_ALLOW_CHECK_FOR_UPDATES: 'false',
    })
    .withTmpFs({ '/database': 'rw' })
    .withWaitStrategy(
      Wait.forHttp('/_matrix/client/versions', CLIENT_SERVER_PORT).forStatusCode(200)
    )
    .withStartupTimeout(120_000)
    // Setup and teardown run in separate Playwright workers.
    .withAutoCleanup(false)
    .start();

  return {
    baseUrl: `http://${container.getHost()}:${String(container.getMappedPort(CLIENT_SERVER_PORT))}`,
    containerId: container.getId(),
  };
}

export async function removeContinuwuity(containerId: string): Promise<void> {
  await execFileAsync('docker', ['rm', '-f', containerId]);
}

export async function registerUser(
  baseUrl: string,
  username: string,
  password: string
): Promise<RegisteredSession> {
  const url = `${baseUrl}/_matrix/client/v3/register?kind=user`;
  const probe = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const response =
    probe.status === 401
      ? await fetch(url, {
          method: 'POST',
          body: JSON.stringify({
            username,
            password,
            auth: {
              type: 'm.login.dummy',
              session: ((await probe.json()) as { session: string }).session,
            },
          }),
        })
      : probe;
  if (!response.ok) {
    throw new Error(`register failed: ${String(response.status)} ${await response.text()}`);
  }
  const registration = (await response.json()) as {
    access_token?: string;
    user_id?: string;
  };
  if (!registration.access_token || !registration.user_id) {
    throw new Error('register response did not include a session');
  }
  return {
    accessToken: registration.access_token,
    userId: registration.user_id,
  };
}

export async function seedTimelineRoom(baseUrl: string, accessToken: string): Promise<string> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
  const create = await fetch(`${baseUrl}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: TIMELINE_ROOM_NAME,
      preset: 'private_chat',
      visibility: 'private',
    }),
  });
  if (!create.ok) {
    throw new Error(`create room failed: ${String(create.status)} ${await create.text()}`);
  }
  const { room_id: roomId } = (await create.json()) as { room_id?: string };
  if (!roomId) throw new Error('create room response did not include a room id');

  for (let index = 0; index < TIMELINE_MESSAGE_COUNT; index += 1) {
    const send = await fetch(
      `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/timeline-${String(index)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          msgtype: 'm.text',
          body: `Timeline message ${String(index)}${index % 7 === 0 ? ` ${'wrap '.repeat(80)}` : ''}`,
        }),
      }
    );
    if (!send.ok) {
      throw new Error(`send message failed: ${String(send.status)} ${await send.text()}`);
    }
  }

  return roomId;
}

export async function sendTimelineMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  transactionId: string,
  body: string
): Promise<void> {
  const response = await fetch(
    `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    }
  );
  if (!response.ok) {
    throw new Error(`send message failed: ${String(response.status)} ${await response.text()}`);
  }
}
