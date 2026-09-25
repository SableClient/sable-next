import type { Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';
import { FakeCoreDriver } from './pages/FakeCoreDriver';

test.use({ storageState: SIGNED_OUT });

async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.SABLE_E2E_SHOTS) return;
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

for (const viewport of [
  { name: 'desktop', size: { width: 1280, height: 800 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
]) {
  test(`a fresh unverified login walks setup through to done on ${viewport.name}`, async ({
    auth,
    page,
    installRoomCore,
  }) => {
    await page.setViewportSize(viewport.size);
    await installRoomCore('onboarding');
    const core = new FakeCoreDriver(page);
    await auth.open('https://example.test');
    await auth.signInWithPassword('e2e', 'password');

    const card = auth.setupCard;
    await expect(page).toHaveURL(/\/setup\/device$/, { timeout: 20_000 });
    await expect(card.getByRole('heading', { name: "Confirm it's you" })).toBeVisible();
    await shot(page, 'device');
    await card.getByRole('button', { name: 'Reset my digital identity' }).click();
    await card.getByRole('checkbox', { name: 'I understand this cannot be undone' }).check();
    await shot(page, 'device-reset');
    await card.getByRole('button', { name: 'Reset my digital identity' }).click();

    await expect(page).toHaveURL(/\/setup\/recovery$/);
    await expect(card.getByRole('textbox', { name: 'Recovery key' })).toHaveValue(
      'e2e-recovery-key'
    );
    const keep = card.getByRole('button', { name: 'Continue' });
    await expect(keep).toBeDisabled();
    await shot(page, 'recovery');
    await card.getByRole('checkbox', { name: "I've written it down" }).check();
    await keep.click();

    await expect(page).toHaveURL(/\/setup\/notifications$/);
    await page.reload();
    await expect(page).toHaveURL(/\/setup\/notifications$/);
    const mentions = card.getByRole('radio', { name: /Mentions and keywords/ });
    await expect(mentions).toHaveAttribute('aria-checked', 'true');
    await page.goBack();
    await expect(page).toHaveURL(/\/setup\/recovery$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/setup\/notifications$/);
    await shot(page, 'notifications');
    await card.getByRole('radio', { name: /All messages/ }).click();
    await card.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/\/setup\/sync$/);
    await expect(card).toContainText("isn't encrypted");
    await shot(page, 'sync');
    await card.getByRole('button', { name: 'Turn on sync' }).click();

    await expect(page).toHaveURL(/\/setup\/done$/);
    await expect(card).toContainText('Confirmed as yours');
    await expect(card).toContainText('Settings sync across devices');
    await shot(page, 'done');
    await card.getByRole('button', { name: 'Go to your chats' }).click();

    await expect(page).toHaveURL(/\/rooms$/);
    expect(await core.commands()).toEqual(
      expect.arrayContaining(['set_default_notification_mode', 'set_account_data'])
    );
    const pending = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('sable-setup:'))
    );
    expect(pending).toEqual([]);

    await page.reload();
    await expect(page).toHaveURL(/\/rooms$/);
  });
}

test.describe('with motion', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('moving to the next step shows only the step it leaves and the one it reaches', async ({
    auth,
    page,
    installRoomCore,
  }) => {
    await installRoomCore('onboarding');
    await auth.open('https://example.test');
    await auth.signInWithPassword('e2e', 'password');
    const card = auth.setupCard;
    await expect(page).toHaveURL(/\/setup\/device$/, { timeout: 20_000 });
    await card.getByRole('button', { name: 'Reset my digital identity' }).click();
    await card.getByRole('checkbox', { name: 'I understand this cannot be undone' }).check();

    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { __e2eSeenCards: Set<string> }).__e2eSeenCards = seen;
      const started = performance.now();
      const sample = () => {
        document.querySelectorAll<HTMLElement>('.rail > .auth-card').forEach((element, index) => {
          if (getComputedStyle(element).visibility !== 'hidden') seen.add(String(index));
        });
        if (performance.now() - started < 1500) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await card.getByRole('button', { name: 'Reset my digital identity' }).click();
    await expect(page).toHaveURL(/\/setup\/recovery$/);
    await page.waitForTimeout(1600);

    const seen = await page.evaluate(() =>
      [...(window as unknown as { __e2eSeenCards: Set<string> }).__e2eSeenCards].sort()
    );
    expect(seen).toEqual(['0', '1']);
  });
});

test('About runs setup again for a device that already finished it', async ({
  auth,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/about');
  await page.getByRole('button', { name: 'Run setup again' }).click();

  const card = auth.setupCard;
  for (const [step, action] of [
    ['profile', 'Skip for now'],
    ['notifications', 'Skip for now'],
    ['appearance', 'Skip for now'],
    ['sync', 'Not now'],
    ['done', 'Go to your chats'],
  ] as const) {
    await expect(page).toHaveURL(new RegExp(`/setup/${step}$`), { timeout: 20_000 });
    await card.getByRole('button', { name: action }).click();
  }

  await expect(page).toHaveURL(/\/rooms$/);
  const pending = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('sable-setup:'))
  );
  expect(pending).toEqual([]);
});

test('touch: a swipe towards a step that is not reachable yet does not move', async ({
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoomCore('ready');
  await page.goto('/settings/about');
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await expect(page).toHaveURL(/\/setup\/profile$/, { timeout: 20_000 });
  await page.waitForTimeout(500);

  const moved = await page.evaluate(async () => {
    const rail = document.querySelector<HTMLElement>('.rail');
    const card = document.querySelector<HTMLElement>('.auth-card.active');
    if (!rail || !card) return null;
    const box = card.getBoundingClientRect();
    const touch = (x: number) =>
      new Touch({ identifier: 1, target: card, clientX: x, clientY: box.top + 40 });
    const before = rail.scrollLeft;
    const start = box.left + box.width / 2;
    card.dispatchEvent(
      new TouchEvent('touchstart', { touches: [touch(start)], bubbles: true, cancelable: true })
    );
    let furthest = 0;
    for (let step = 1; step <= 10; step += 1) {
      card.dispatchEvent(
        new TouchEvent('touchmove', {
          touches: [touch(start - step * 20)],
          bubbles: true,
          cancelable: true,
        })
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      furthest = Math.max(furthest, Math.abs(rail.scrollLeft - before));
    }
    card.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    return furthest;
  });

  expect(moved).toBe(0);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/setup\/profile$/);
});

test('a rail knocked off the current step by a relayout settles back onto it', async ({
  auth,
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/about');
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await expect(page).toHaveURL(/\/setup\/profile$/, { timeout: 20_000 });
  await auth.setupCard.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/\/setup\/notifications$/);

  const offset = () =>
    page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.rail');
      const card = rail?.querySelector<HTMLElement>(':scope > .auth-card.active');
      if (!rail || !card) return null;
      return Math.round(
        rail.scrollLeft - (card.offsetLeft - (rail.clientWidth - card.offsetWidth) / 2)
      );
    });
  await expect.poll(offset).toBe(0);
  await page.screenshot({ fullPage: true });
  await expect.poll(offset).toBe(0);
  await expect(page).toHaveURL(/\/setup\/notifications$/);
});
