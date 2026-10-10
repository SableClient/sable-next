import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

for (const scheme of ['light', 'dark'] as const) {
  test(`a pinned message names its sender in the colour of their messages on the ${scheme} theme`, async ({
    app,
    core,
    page,
    installRoomCore,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(() => {
      (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
        name_color_light: '#b0306a',
        name_color_dark: '#f09ac0',
      };
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await core.emitTimelineDiff(await core.subscription(), [
      {
        op: 'push_back',
        value: {
          ...timelineItem('pin-alice', ''),
          sender: '@e2e:example.test',
          sender_name: 'E2E User',
          content: {
            kind: 'state_event',
            event_type: 'm.room.pinned_events',
            state_key: '',
            content: null,
            prev_content: null,
            change: {
              kind: 'pinned_events',
              added: ['$general-1:example.test'],
              removed: [],
              total: 1,
            },
          },
        },
      },
    ]);

    const target = page.locator('.target-preview .target-name', { hasText: 'Alice' });
    await expect(target).toHaveClass(/tinted/);
    const header = page.locator('.sender-identity-name.tinted', { hasText: 'Alice' }).first();
    const colour = (locator: typeof target) =>
      locator.evaluate((node) => getComputedStyle(node).color);
    expect(await colour(target)).toBe(await colour(header));
  });
}

test('a pinned dark theme corrects names for the dark ground on a light browser', async ({
  app,
  page,
  installRoomCore,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ theme: 'dark' }));
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      name_color_light: '#b0306a',
      name_color_dark: '#f09ac0',
    };
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');

  const name = page.locator('.sender-identity-name.tinted', { hasText: 'Alice' }).first();
  await expect(name).toBeVisible();
  const colours = await name.evaluate((node) => {
    const probe = document.createElement('span');
    probe.style.color = getComputedStyle(node).getPropertyValue('--name-color-on-dark');
    document.body.append(probe);
    const dark = getComputedStyle(probe).color;
    probe.remove();
    return { shown: getComputedStyle(node).color, dark };
  });
  expect(colours.shown).toBe(colours.dark);
});
