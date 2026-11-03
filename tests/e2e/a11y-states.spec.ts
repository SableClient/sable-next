import type { VerificationView } from '#src/generated/protocol';

import { violations, type KnownViolation } from './fixtures/a11y';
import { timelineItem } from './fixtures/timeline-items';
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const ROOM_ID = '!room:example.test';
const BADGE_TEXT: KnownViolation = {
  rule: 'label-content-name-mismatch',
  html: /data-tooltip-trigger/,
  reason: 'an unread badge keeps its screen reader text inside a control named by aria-label',
};
const QUICK_REACTIONS: KnownViolation = {
  rule: 'aria-required-children',
  html: /role="menu"/,
  reason: 'the quick reaction strip holds plain buttons inside the menu',
};
const CATALOG = 'https://git.sable.moe/SableClient/themes/raw/branch/main/';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.describe('desktop room', () => {
  test.beforeEach(async ({ app, core, installRoomCore }) => {
    await installRoomCore('ready');
    await app.openRoom(ROOM_ID);
    await core.emitTimelineDiff(await core.subscription(), [
      {
        op: 'reset',
        values: [timelineItem('a11y-1', 'First message'), timelineItem('a11y-2', 'Second message')],
      },
    ]);
  });

  test('the room with a timeline has no violations', async ({ page, timeline }) => {
    await expect(timeline.itemById('a11y-2')).toBeVisible();
    expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
  });

  test('the message context menu has no violations', async ({ page, timeline }) => {
    await timeline.itemById('a11y-2').locator('article.message').click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await violations(page, { scope: '[role="menu"]', known: [QUICK_REACTIONS] })).toEqual(
      []
    );
  });

  test('the room menu has no violations', async ({ app, page }) => {
    await app.roomLink('General').focus();
    await page.keyboard.press('ContextMenu');
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await violations(page, { scope: '[role="menu"]' })).toEqual([]);
  });

  test('the command palette has no violations', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Jump to room' })).toBeVisible();
    expect(await violations(page, { scope: '[role="dialog"]' })).toEqual([]);
  });

  test('the shortcuts help dialog has no violations', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('button', { name: 'Show keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    expect(await violations(page, { scope: '[role="dialog"]' })).toEqual([]);
  });

  test('the device verification dialog has no violations in each phase', async ({ page }) => {
    const phases: VerificationView[] = [
      { phase: 'choose', qr: null, can_scan: false, can_compare: true },
      { phase: 'waiting' },
      {
        phase: 'compare',
        emojis: [
          { symbol: '🐶', description: 'Dog' },
          { symbol: '🐱', description: 'Cat' },
        ],
        decimals: [1, 2, 3],
      },
      { phase: 'done' },
    ];
    const dialog = page.getByRole('dialog', { name: 'Device verification' });
    for (const state of phases) {
      await page.evaluate((state) => {
        window.__e2eEmitTimelineEvent({
          type: 'verification',
          user_id: '@e2e:example.test',
          flow_id: 'states-flow',
          state,
        });
      }, state);
      await expect(dialog).toBeVisible();
      expect(await violations(page, { scope: '[role="dialog"]' }), state.phase).toEqual([]);
    }
  });
});

test('the settings account page and both profile tabs have no violations', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/settings/account');
  const tabs = page.getByRole('tablist', { name: 'Profile' });
  await expect(tabs).toBeVisible();
  expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);

  await tabs.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Preview' })).toBeVisible();
  expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
});

test('the theme catalogue has no violations', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.route(`${CATALOG}**`, (route) =>
    route.fulfill(
      route.request().url().endsWith('catalog.json')
        ? {
            json: {
              themes: [
                {
                  basename: 'Midnight',
                  previewUrl: null,
                  fullUrl: `${CATALOG}themes/midnight.css`,
                },
              ],
              tweaks: [],
            },
          }
        : {
            body: '/*\n@sable-theme\nname: Midnight\nkind: dark\ncontrast: low\n*/\n.x { --sable-bg-container: #101018; }',
          }
    )
  );
  await page.goto('/settings/appearance');
  await page.getByRole('button', { name: 'Theme catalogue', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Theme catalogue' })).toBeVisible();
  await expect(
    page.getByRole('tabpanel').getByRole('button', { name: 'Install', exact: true })
  ).toHaveCount(1);
  expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
});

test('an empty room list has no violations', async ({ app, page, installRoomCore }) => {
  await installRoomCore('empty_room');
  await app.openRooms();
  await expect(app.primaryNavigation).toBeVisible();
  expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
});

test('the session restore error has no violations', async ({ page, installRoomCore }) => {
  await installRoomCore('error');
  await page.goto('/rooms');
  await expect(
    page.getByRole('heading', { name: 'Unable to restore your session.' })
  ).toBeVisible();
  expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the app shell and a room have no violations in the ${theme} theme`, async ({
    app,
    page,
    installRoomCore,
  }) => {
    await page.addInitScript((theme) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ theme }));
    }, theme);
    await installRoomCore('ready');
    await app.openRooms();
    await expect(app.primaryNavigation).toBeVisible();
    expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);

    await app.openRoom(ROOM_ID);
    await expect(app.composer).toBeVisible();
    expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
  });
}

test.describe('phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the room list and a room have no violations', async ({ app, page, installRoomCore }) => {
    await installRoomCore('ready');
    await app.openRooms();
    await expect(app.primaryNavigation).toBeVisible();
    expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);

    await app.openRoom(ROOM_ID);
    await expect(app.composer).toBeVisible();
    expect(await violations(page, { known: [BADGE_TEXT] })).toEqual([]);
  });
});
