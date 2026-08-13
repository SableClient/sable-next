import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test as setup } from '@playwright/test';
import { registerUser, startContinuwuity } from './fixtures/continuwuity';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { homeserverStatePath } from './fixtures/runtime';

setup('provision homeserver', async () => {
  const homeserver = await startContinuwuity();
  await registerUser(homeserver.baseUrl, LOGIN_USERNAME, LOGIN_PASSWORD);
  const statePath = homeserverStatePath();
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(homeserver));
});
