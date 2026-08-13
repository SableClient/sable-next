import { readFile } from 'node:fs/promises';
import { test as teardown } from '@playwright/test';
import { removeContinuwuity } from './fixtures/continuwuity';
import { homeserverStatePath } from './fixtures/runtime';

teardown('remove homeserver', async () => {
  try {
    const { containerId } = JSON.parse(await readFile(homeserverStatePath(), 'utf8')) as {
      containerId: string;
    };
    await removeContinuwuity(containerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
});
