import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ installRoomCore }) => {
  await installRoomCore('ready');
});

test('search sharing starts by default and can be turned off', async ({ page }) => {
  await page.goto('/rooms');
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__e2eCalls.filter((call) => call.method === 'search.peer_start').length
      )
    )
    .toBeGreaterThan(0);
  const calls = await page.evaluate(() => window.__e2eCalls);
  const options = calls.find((call) => call.method === 'session.set_search_options');
  expect(options?.params).toMatchObject({ sharing: true, crawler: true });
  expect(calls.findIndex((call) => call.method === 'session.set_search_options')).toBeLessThan(
    calls.findIndex((call) => call.method === 'search.peer_start')
  );

  await page.goto('/settings/timeline');
  await expect(
    page.getByRole('switch', { name: 'Share the search index between devices', exact: true })
  ).toBeChecked();
  await expect(
    page.getByText(
      'Open Sable on both devices on the same network. Indexing continues if they cannot connect.'
    )
  ).toBeVisible();

  await page
    .getByRole('switch', { name: 'Share the search index between devices', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const calls = window.__e2eCalls.filter(
          (call) => call.method === 'session.set_search_options'
        );
        return calls.at(-1)?.params;
      })
    )
    .toMatchObject({ sharing: false });
});

test('unsupported browsers keep direct sharing unavailable without starting it', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'RTCPeerConnection', { value: undefined });
  });
  await page.goto('/settings/timeline');
  await expect(page.getByText('Direct sharing unavailable', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const calls = window.__e2eCalls.filter(
          (call) => call.method === 'session.set_search_options'
        );
        return calls.at(-1)?.params;
      })
    )
    .toMatchObject({ sharing: false });
  expect(await page.evaluate(() => window.__e2eCommands.includes('search.peer_start'))).toBe(false);
});
