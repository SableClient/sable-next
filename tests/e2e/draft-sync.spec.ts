import type { BrowserContext, Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { LOGIN_PASSWORD, LOGIN_USERNAME } from './fixtures/loginAccount';
import { AppShell } from './pages/AppShell';
import { AuthFlow } from './pages/AuthFlow';

test.use({ storageState: SIGNED_OUT });

async function syncing(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem(
      'sable-preferences',
      JSON.stringify({ settingsSync: true, syncDrafts: true })
    );
  });
}

async function signInOn(page: Page, homeserver: string): Promise<void> {
  const auth = new AuthFlow(page);
  await auth.open(homeserver);
  await auth.revealPasswordLogin();
  await auth.signInWithPassword(LOGIN_USERNAME, LOGIN_PASSWORD);
  await auth.finishSetup();
}

test('an unsent draft reaches another signed-in device', async ({
  browser,
  page,
  app,
  homeserver,
  scratchRoom,
  signIn,
}) => {
  test.setTimeout(120_000);
  await syncing(page.context());
  await signIn();
  await app.openRoom(scratchRoom.roomId);

  const other = await browser.newContext({ storageState: SIGNED_OUT });
  await syncing(other);
  const otherPage = await other.newPage();
  await signInOn(otherPage, homeserver.baseUrl);
  const otherApp = new AppShell(otherPage);
  await otherApp.openRoom(scratchRoom.roomId);

  const draft = `Draft ${String(Date.now())}`;
  await app.composer.fill(draft);

  await expect(otherApp.composer).toHaveText(draft, { timeout: 45_000 });
  await other.close();
});
