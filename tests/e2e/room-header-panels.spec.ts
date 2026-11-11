import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1400, height: 900 } });

test('opening a side panel leaves the room header and its buttons in place', async ({
  app,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const threads = page
    .getByRole('toolbar', { name: en.room.actionsLabel })
    .getByRole('button', { name: en.timeline.threadsOpen });
  await expect(threads).toBeVisible();
  const before = await threads.boundingBox();

  await threads.click();
  await expect(page.getByRole('complementary', { name: en.timeline.threadsTitle })).toBeVisible();
  const after = await threads.boundingBox();

  expect(after).toEqual(before);
});
