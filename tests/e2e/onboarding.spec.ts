import { expect, test, SIGNED_OUT } from './fixtures/test';
import { FakeCoreDriver } from './pages/FakeCoreDriver';

test.use({ storageState: SIGNED_OUT });

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
    await card.getByRole('button', { name: 'Reset my digital identity' }).click();
    await card.getByRole('checkbox', { name: 'I understand this cannot be undone' }).check();
    await card.getByRole('button', { name: 'Reset my digital identity' }).click();

    await expect(page).toHaveURL(/\/setup\/recovery$/);
    await expect(card.getByRole('textbox', { name: 'Recovery key' })).toHaveValue(
      'e2e-recovery-key'
    );
    const keep = card.getByRole('button', { name: 'Continue' });
    await expect(keep).toBeDisabled();
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
    await card.getByRole('radio', { name: /All messages/ }).click();
    await card.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/\/setup\/sync$/);
    await expect(card).toContainText('unencrypted data');
    await card.getByRole('button', { name: 'Turn on sync' }).click();

    await expect(page).toHaveURL(/\/setup\/done$/);
    await expect(card).toContainText('Confirmed as yours');
    await expect(card).toContainText('Settings sync across devices');
    await expect(card).toContainText('Group chats: all messages');
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

test('mobile hides neighboring cards and card navigation preserves page scroll', async ({
  auth,
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await installRoomCore('ready');
  await page.goto('/settings/about');
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await expect(page).toHaveURL(/\/setup\/profile$/, { timeout: 20_000 });
  await auth.setupCard.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/\/setup\/notifications$/);

  const adjacent = page.locator('.rail > .auth-card.before');
  await expect(adjacent).toBeVisible();
  const appearance = page.locator('.rail > .auth-card.after').first();
  await expect(appearance).toBeVisible();
  await expect(appearance.locator('.stage-activation')).toBeEnabled();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  for (const card of [adjacent, appearance]) {
    const { opacity, visibleWidth } = await card.evaluate((element) => {
      const rail = element.parentElement?.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return {
        opacity: Number(getComputedStyle(element).opacity),
        visibleWidth: rail
          ? Math.max(0, Math.min(rail.right, bounds.right) - Math.max(rail.left, bounds.left))
          : 0,
      };
    });
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    expect(visibleWidth).toBe(0);
  }

  const before = await page.evaluate(() => {
    window.scrollTo(0, 120);
    return window.scrollY;
  });
  expect(before).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page).toHaveURL(/\/setup\/profile$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Next' }).first().click();
  await expect(page).toHaveURL(/\/setup\/notifications$/);
  await page.getByRole('button', { name: 'Next' }).first().click();
  await expect(page).toHaveURL(/\/setup\/appearance$/);
});

test.describe('with motion', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('moving to the next step gives full opacity only to the cards in transition', async ({
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
          if (Number(getComputedStyle(element).opacity) >= 0.9) seen.add(String(index));
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

for (const viewport of [
  { name: 'desktop', size: { width: 1280, height: 800 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
]) {
  test(`About runs setup again on ${viewport.name}`, async ({ auth, page, installRoomCore }) => {
    await page.setViewportSize(viewport.size);
    await installRoomCore('ready');
    await page.goto('/settings/about');
    await page.getByRole('button', { name: 'Run setup again' }).click();

    const card = auth.setupCard;
    for (const [step, action] of [
      ['profile', 'Skip for now'],
      ['notifications', 'Skip for now'],
      ['appearance', 'Continue'],
      ['layout', 'Continue'],
      ['sync', 'Not now'],
      ['done', 'Go to your chats'],
    ] as const) {
      await expect(page).toHaveURL(new RegExp(`/setup/${step}$`), { timeout: 20_000 });
      if (step === 'appearance') {
        await card.getByRole('button', { name: 'Browse more themes' }).click();
        await expect(page.getByRole('dialog', { name: 'Theme catalogue' })).toBeVisible();
        await page.getByRole('button', { name: 'Close catalogue' }).click();
        await card.getByRole('radio', { name: 'Dark' }).click();
      }
      if (step === 'layout') {
        await card.getByRole('radio', { name: 'Compact', exact: true }).check();
        await card.getByRole('radio', { name: 'Expanded card' }).check();
      }
      await card.getByRole('button', { name: action }).click();
    }

    await expect(page).toHaveURL(/\/rooms$/);
    const pending = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('sable-setup:'))
    );
    expect(pending).toEqual([]);
  });
}

test('touch: a swipe past device confirmation does not move', async ({
  auth,
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoomCore('onboarding');
  await auth.open('https://example.test');
  await auth.signInWithPassword('e2e', 'password');
  await expect(page).toHaveURL(/\/setup\/device$/, { timeout: 20_000 });
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
  await expect(page).toHaveURL(/\/setup\/device$/);
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
