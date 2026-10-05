import { expect, test, SIGNED_OUT } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: SIGNED_OUT });

for (const scheme of ['light', 'dark'] as const) {
  test(`a reply names its sender in the colour of their messages on the ${scheme} theme`, async ({
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
          ...timelineItem('reply-to-alice', 'Replying to Alice'),
          sender: '@e2e:example.test',
          sender_name: 'E2E User',
          in_reply_to: {
            event_id: '$general-1:example.test',
            sender: '@alice:example.test',
            sender_mentioned: false,
            sender_name: 'Alice',
            body: 'General message 1',
          },
        },
      },
    ]);

    const reply = page.locator('.reply-preview .reply-name');
    await expect(reply).toHaveClass(/tinted/);
    const header = page.locator('.sender-identity-name.tinted', { hasText: 'Alice' }).first();
    const colour = (locator: typeof reply) =>
      locator.evaluate((node) => getComputedStyle(node).color);
    expect(await colour(reply)).toBe(await colour(header));
  });

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

test('a compact connected reply keeps its connector clear of the name gutter', async ({
  app,
  core,
  page,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'sable-preferences',
      JSON.stringify({ layout: 'compact', replyPreviewStyle: 'connected' })
    );
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'push_back',
      value: {
        ...timelineItem('compact-reply', 'Replying to Alice'),
        sender: '@bob:example.test',
        sender_name: 'Bob',
        in_reply_to: {
          event_id: '$general-1:example.test',
          sender: '@alice:example.test',
          sender_mentioned: false,
          sender_name: 'Alice',
          body: 'General message 1',
        },
      },
    },
  ]);

  const row = page
    .locator('.message')
    .filter({ has: page.locator('.reply-connected') })
    .last();
  const { gutterRight, connectorLeft } = await row.evaluate((node) => {
    const gutter = node.querySelector('.compact-gutter');
    const reply = node.querySelector('.reply-connected');
    if (!gutter || !reply) throw new Error('missing compact reply parts');
    return {
      gutterRight: gutter.getBoundingClientRect().right,
      connectorLeft:
        reply.getBoundingClientRect().left + parseFloat(getComputedStyle(reply, '::before').left),
    };
  });
  expect(connectorLeft).toBeGreaterThanOrEqual(gutterRight);
});

test('a mobile connected reply aligns its preview text with the sender name', async ({
  app,
  core,
  page,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ replyPreviewStyle: 'connected' }));
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await core.emitTimelineDiff(await core.subscription(), [
    {
      op: 'push_back',
      value: {
        ...timelineItem('aligned-reply', 'Replying to Alice'),
        sender: '@bob:example.test',
        sender_name: 'Bob',
        in_reply_to: {
          event_id: '$general-1:example.test',
          sender: '@alice:example.test',
          sender_mentioned: false,
          sender_name: 'Alice',
          body: 'General message 1',
        },
      },
    },
  ]);

  const reply = page.locator('[data-item-id="aligned-reply"] .reply-connected');
  await expect(reply).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const offset = await reply.evaluate((node) => {
    const name = node.querySelector('.reply-name');
    const body = node.querySelector('.reply-body');
    if (!name || !body) throw new Error('Missing reply text');
    const range = document.createRange();
    range.selectNodeContents(name);
    const nameTop = range.getBoundingClientRect().top;
    range.selectNodeContents(body);
    return Math.abs(nameTop - range.getBoundingClientRect().top);
  });
  expect(offset).toBeLessThanOrEqual(1);
});

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
