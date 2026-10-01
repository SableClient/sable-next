import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

const css = `/* @sable-theme */
body.sable-remote-theme {
  --sable-bg-container: #101020;
  --sable-bg-on-container: #dddddd;
  --sable-bg-container-hover: #181828;
  --sable-bg-container-active: #202030;
  --sable-bg-container-line: #334455;
  --sable-surface-container: #203040;
  --sable-surface-on-container: #eeeeee;
  --sable-surface-container-hover: #283848;
  --sable-surface-container-active: #304050;
  --sable-surface-container-line: #456789;
  --sable-surface-var-container: #304050;
  --sable-surface-var-on-container: #ffffff;
  --sable-surface-var-container-hover: #384858;
  --sable-surface-var-container-active: #405060;
  --sable-primary-main: #abcdef;
  --sable-primary-on-main: #123456;
  --sable-crit-main: #aa3344;
  --sable-shadow: #123456;
  --tc-link: #fedcba;
  --mx-uc-1: #aabbcc;
  --mx-uc-2: #aabbcc;
  --mx-uc-3: #aabbcc;
  --mx-uc-4: #aabbcc;
  --mx-uc-5: #aabbcc;
  --mx-uc-6: #aabbcc;
  --mx-uc-7: #aabbcc;
  --mx-uc-8: #aabbcc;
}`;

async function installTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ({ css, theme }) => {
      localStorage.setItem('sable-preferences', JSON.stringify({ theme }));
      localStorage.setItem(
        'sable-custom-themes',
        JSON.stringify({
          themes: [{ id: 'test-theme', name: 'Test theme', kind: theme, css }],
          lightThemeId: theme === 'light' ? 'test-theme' : null,
          darkThemeId: theme === 'dark' ? 'test-theme' : null,
        })
      );
    },
    { css, theme }
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`imported variables reach shared primitives on the ${theme} theme`, async ({
    page,
    app,
    core,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await installTheme(page, theme);
    await page.goto('/settings/appearance');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(16, 16, 32)');
    expect(
      await page
        .locator('body')
        .evaluate((body) => getComputedStyle(body).getPropertyValue('--focus-ring'))
    ).toContain('#abcdef');
    await expect.soft(page.locator('.settings-content')).toHaveCSS('color', 'rgb(238, 238, 238)');
    await page.setViewportSize({ width: 1600, height: 900 });
    const settingsSearch = page.locator('#settings-search-input');
    await expect(settingsSearch.locator('..')).toHaveCSS('background-color', 'rgb(32, 48, 64)');
    await expect(settingsSearch).toHaveCSS('color', 'rgb(238, 238, 238)');
    await page.setViewportSize({ width: 1280, height: 720 });
    const quickCss = page.getByRole('textbox', { name: 'Quick CSS', exact: true });
    await expect(quickCss).toHaveCSS('background-color', 'rgb(16, 16, 32)');
    await expect(quickCss).toHaveCSS('color', 'rgb(221, 221, 221)');
    await expect(quickCss).toHaveCSS('box-shadow', 'rgb(51, 68, 85) 0px 0px 0px 1.5px inset');
    await quickCss.focus();
    await expect(quickCss).toHaveCSS('box-shadow', 'rgb(171, 205, 239) 0px 0px 0px 3px inset');
    await quickCss.evaluate((input) => {
      input.setAttribute('aria-invalid', 'true');
    });
    await expect(quickCss).toHaveCSS('box-shadow', 'rgb(170, 51, 68) 0px 0px 0px 3px inset');
    await quickCss.evaluate((input) => {
      input.removeAttribute('aria-invalid');
    });
    const mode = page.getByLabel('Light or dark', { exact: true });
    await expect(mode).toHaveCSS('background-color', 'rgb(16, 16, 32)');
    await expect(mode).toHaveCSS('color', 'rgb(221, 221, 221)');
    await expect
      .soft(page.locator('.settings-section-content').first())
      .toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect
      .soft(page.locator('.dialog-content-settings'))
      .toHaveCSS('box-shadow', 'rgb(18, 52, 86) 0px 4px 26px -6px');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Switch account', exact: true }).click();
    await expect.soft(page.locator('.menu-surface')).toHaveCSS('color', 'rgb(238, 238, 238)');
    await expect
      .soft(page.locator('.menu-surface'))
      .toHaveCSS('box-shadow', 'rgb(18, 52, 86) 0px 1px 12px -3px');
    await app.openRoom('!room:example.test');
    await expect.soft(page.locator('.room-view')).toHaveCSS('color', 'rgb(238, 238, 238)');
    await expect.soft(app.composer).toHaveCSS('color', 'rgb(255, 255, 255)');
    await core.emitTimelineDiff(await core.subscription(), [
      {
        op: 'push_back',
        value: {
          ...timelineItem(
            'theme-link',
            '<a href="https://example.org">Theme link</a> <code>code</code>'
          ),
          thread_summary: {
            num_replies: 3,
            latest_body: 'a reply',
            latest_sender: '@bob:example.test',
          },
        },
      },
    ]);
    await expect
      .soft(page.getByRole('link', { name: 'Theme link', exact: true }))
      .toHaveCSS('color', 'rgb(254, 220, 186)');
    await expect
      .soft(page.locator('.sender-identity-name', { hasText: 'Alice' }).first())
      .toHaveCSS('color', 'rgb(170, 187, 204)');
    await expect
      .soft(page.locator('.formatted-body code').first())
      .toHaveCSS('color', 'rgb(255, 255, 255)');
    if (!(await page.locator('.members-drawer').isVisible())) {
      await page.locator('.members-button').click();
    }
    await expect.soft(page.locator('.members-drawer')).toHaveCSS('color', 'rgb(221, 221, 221)');
    await expect
      .soft(page.locator('.member-search-input'))
      .toHaveCSS('color', 'rgb(238, 238, 238)');
    const memberSearch = page.locator('.member-search-input');
    await expect(memberSearch).toHaveCSS('box-shadow', 'rgb(69, 103, 137) 0px 0px 0px 1.5px inset');
    await memberSearch.focus();
    await expect(memberSearch).toHaveCSS('box-shadow', 'rgb(171, 205, 239) 0px 0px 0px 3px inset');
    await page.locator('.members-button').click();
    await page.evaluate(() => {
      document.body.style.setProperty('--tc-link', 'initial');
      for (let slot = 1; slot <= 8; slot += 1) {
        document.body.style.setProperty(`--mx-uc-${slot}`, 'initial');
      }
    });
    await expect(page.getByRole('link', { name: 'Theme link', exact: true })).toHaveCSS(
      'color',
      'rgb(171, 205, 239)'
    );
    await expect(page.locator('.sender-identity-name', { hasText: 'Alice' }).first()).toHaveCSS(
      'color',
      'rgb(171, 205, 239)'
    );
    await app.composer.fill('Later');
    await page.locator('.composer-send').click({ button: 'right' });
    await expect
      .soft(page.locator('.date-time-field-input'))
      .toHaveCSS('color', 'rgb(221, 221, 221)');
    await expect
      .soft(page.locator("[data-segment='literal']").first())
      .toHaveCSS('color', 'rgb(221, 221, 221)');
    await page.keyboard.press('Escape');
    await page.locator('.thread-summary').first().click();
    await expect.soft(page.locator('.thread-view')).toHaveCSS('color', 'rgb(238, 238, 238)');
    await page.goto('/settings/devices');
    await expect
      .soft(page.locator('.bulk-select-all input'))
      .toHaveCSS('accent-color', 'rgb(171, 205, 239)');
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`mobile: imported variables reach settings and profiles on the ${theme} theme`, async ({
    page,
    installRoomCore,
  }) => {
    await installRoomCore('ready');
    await installTheme(page, theme);
    await page.goto('/settings');
    const search = page.locator('#settings-search-input');
    await expect(search.locator('..')).toHaveCSS('background-color', 'rgb(32, 48, 64)');
    await expect(search).toHaveCSS('color', 'rgb(238, 238, 238)');
    await page.goto('/settings/appearance');
    await expect(page.locator('.section-bar')).toHaveCSS('color', 'rgb(238, 238, 238)');
    await expect(page.getByRole('textbox', { name: 'Quick CSS', exact: true })).toHaveCSS(
      'color',
      'rgb(221, 221, 221)'
    );
    await page.goto('/profile');
    await expect(page.locator('.profile-card')).toHaveCSS('color', 'rgb(238, 238, 238)');
  });
}
