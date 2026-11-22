import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { MatrixAdmin } from './fixtures/matrix';
import { solidPng } from './fixtures/png';

test.use({ storageState: SIGNED_OUT });

const HISTORY = 'moe.sable.next.sticker_history';
const WORKSPACE = 'moe.sable.next.workspace';

function accountData(account: MatrixAdmin, type: string): string {
  return `client/v3/user/${encodeURIComponent(account.userId)}/account_data/${type}`;
}

test('stickers stay local until sync is on, then share counts with older builds', async ({
  page,
  app,
  freshLogin,
}) => {
  test.setTimeout(120_000);
  const account = await freshLogin();
  const urls = new Map<string, string>();
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
    urls.set(name, await account.uploadMedia(solidPng(32, 32), 'image/png', `${name}.png`));
  }
  await account.request('PUT', accountData(account, 'im.ponies.user_emotes'), {
    pack: { display_name: 'History', usage: ['sticker'] },
    images: Object.fromEntries([...urls].map(([name, source]) => [name, { url: source }])),
  });
  const roomId = await account.createRoom({ name: 'Sticker history' });

  const open = async (): Promise<void> => {
    await app.openRoom(roomId);
    await page.getByRole('button', { name: 'Emotes and stickers' }).click();
    await page.getByRole('button', { name: 'Stickers', exact: true }).click();
  };
  for (let pick = 0; pick < 2; pick += 1) {
    await open();
    await page.getByRole('button', { name: ':alpha:', exact: true }).first().click();
  }
  await open();
  await expect(page.getByRole('button', { name: ':alpha:', exact: true })).toHaveCount(2);
  const unsynced = await fetch(`${account.baseUrl}/_matrix/${accountData(account, HISTORY)}`, {
    headers: { authorization: `Bearer ${account.accessToken}` },
  });
  expect(unsynced.status).toBe(404);

  await account.request('PUT', accountData(account, WORKSPACE), {
    v: 1,
    recentStickers: [urls.get('beta'), urls.get('gamma')],
    fromAnotherBuild: true,
  });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as object;
    localStorage.setItem('sable-preferences', JSON.stringify({ ...saved, settingsSync: true }));
  });
  await page.reload();

  const history = async (): Promise<unknown> => {
    const content = await account
      .request<{ recent_stickers: { sticker: string; total: number }[] }>(
        'GET',
        accountData(account, HISTORY)
      )
      .catch(() => null);
    return content?.recent_stickers.map(({ sticker, total }) => [sticker, total]);
  };
  await expect.poll(history, { timeout: 30_000 }).toEqual([
    [urls.get('alpha'), 2],
    [urls.get('beta'), 1],
    [urls.get('gamma'), 1],
  ]);
  const workspace = (): Promise<Record<string, unknown>> =>
    account.request('GET', accountData(account, WORKSPACE));
  await expect
    .poll(async () => (await workspace()).recentStickers, { timeout: 30_000 })
    .toEqual([urls.get('alpha'), urls.get('beta'), urls.get('gamma')]);
  const mirrored = await workspace();
  expect(mirrored.fromAnotherBuild).toBe(true);

  // An older build puts its pick at the front of the list it knows.
  await account.request('PUT', accountData(account, WORKSPACE), {
    ...mirrored,
    recentStickers: ['delta', 'alpha', 'beta', 'gamma'].map((name) => urls.get(name)),
  });
  await expect.poll(history, { timeout: 30_000 }).toEqual([
    [urls.get('delta'), 1],
    [urls.get('alpha'), 2],
    [urls.get('beta'), 1],
    [urls.get('gamma'), 1],
  ]);
});
