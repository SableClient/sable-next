import { expect, test, SIGNED_OUT } from './fixtures/test';

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile profile status' : 'desktop profile status', () => {
    test.use({
      storageState: SIGNED_OUT,
      hasTouch: mobile,
      viewport: mobile ? { width: 412, height: 915 } : { width: 1280, height: 800 },
    });

    test('presence and status stay unchanged until Save', async ({ page, installRoomCore }) => {
      await page.addInitScript(() => {
        localStorage.setItem('sable-preferences', JSON.stringify({ presence: 'online' }));
        (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
          status: { text: 'Working on Sable', emoji: null },
        };
      });
      await installRoomCore('ready');
      await page.goto('/profile');
      const bubble = page.locator('.status-bubble');
      await expect(bubble).toContainText('Working on Sable');
      await bubble.click();
      const dialog = page.getByRole('dialog');
      const editor = dialog.getByRole('textbox', { name: 'Status message' });
      const save = dialog.getByRole('button', { name: 'Save', exact: true });
      await expect(save).toBeDisabled();
      await dialog.getByRole('radio', { name: 'Offline', exact: true }).click();
      await expect(save).toBeEnabled();
      await editor.fill('Taking a break');
      await expect(bubble).toContainText('Online');
      await expect(bubble).toContainText('Working on Sable');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).first().click();
      await expect(dialog).not.toBeVisible();
      await expect(bubble).toContainText('Online');
      await expect(bubble).toContainText('Working on Sable');
      await bubble.click();
      await expect(dialog.getByRole('radio', { name: 'Online', exact: true })).toHaveAttribute(
        'data-selected',
        'true'
      );
      await expect(editor).toHaveValue('Working on Sable');
      await dialog.getByRole('radio', { name: 'Away', exact: true }).click();
      await save.click();
      await expect(dialog).not.toBeVisible();
      await expect(bubble).toContainText('Away');
      await expect(bubble).toContainText('Working on Sable');
      await bubble.click();
      await dialog.getByRole('radio', { name: 'Offline', exact: true }).click();
      await editor.fill('Taking a break');
      await save.click();
      await expect(dialog).not.toBeVisible();
      await expect(bubble).toContainText('Offline');
      await expect(bubble).toContainText('Taking a break');
    });

    test('a failed status save keeps presence unchanged and preserves the draft', async ({
      page,
      installRoomCore,
    }) => {
      await page.addInitScript(() => {
        localStorage.setItem('sable-preferences', JSON.stringify({ presence: 'online' }));
        (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
          status: { text: 'Working on Sable', emoji: null },
        };
        window.__e2eProfileSaveError = true;
      });
      await installRoomCore('ready');
      await page.goto('/profile');
      const bubble = page.locator('.status-bubble');
      await expect(bubble).toContainText('Working on Sable');
      await bubble.click();
      const dialog = page.getByRole('dialog');
      const editor = dialog.getByRole('textbox', { name: 'Status message' });
      await dialog.getByRole('radio', { name: 'Offline', exact: true }).click();
      await editor.fill('Taking a break');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Could not save your profile changes.');
      await expect(editor).toHaveValue('Taking a break');
      await expect(bubble).toContainText('Online');
      await expect(bubble).toContainText('Working on Sable');
      await page.evaluate(() => (window.__e2eProfileSaveError = false));
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(bubble).toContainText('Offline');
      await expect(bubble).toContainText('Taking a break');
    });

    for (const sendPresence of [false, true]) {
      test(`the account page shows the saved profile status with presence sharing ${String(sendPresence)}`, async ({
        page,
        installRoomCore,
      }) => {
        await page.addInitScript((sendPresence) => {
          localStorage.setItem('sable-preferences', JSON.stringify({ sendPresence }));
          (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
            status: { text: 'Working on Sable', emoji: '🚀' },
            supporter_awards: null,
            legacy_fields: ['chat.commet.profile_status'],
          };
        }, sendPresence);
        await installRoomCore('ready');
        await page.goto('/profile');
        const status = sendPresence
          ? page.locator('.status-bubble')
          : page.getByRole('region', { name: 'Status', exact: true });
        await expect(status).toBeVisible();
        await expect(status).toContainText('Working on Sable');
        await expect(status).toContainText('🚀');
        await expect(page.locator('.profile-card')).not.toContainText('What are you up to?');
        if (sendPresence) {
          await expect(page.locator('.profile-card-status')).toHaveCount(0);
          await page.locator('.status-bubble').click();
          await expect(page.getByRole('radio', { name: 'Online', exact: true })).toBeFocused();
          const editor = page.getByRole('textbox', { name: 'Status message' });
          await expect(editor).toHaveValue('Working on Sable');
          await editor.fill('Taking a break');
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(page.getByRole('dialog')).not.toBeVisible();
          await expect(status).toContainText('Taking a break');
          await expect(status).toContainText('🚀');
          expect(await page.evaluate(() => window.__e2eCommandPayloads)).toEqual(
            expect.arrayContaining([
              {
                type: 'set_profile_field',
                field: 'm.status',
                value: { text: 'Taking a break', emoji: '🚀' },
              },
              { type: 'set_profile_field', field: 'chat.commet.profile_status', value: null },
            ])
          );
          await status.click();
          await expect(page.getByRole('radio', { name: 'Online', exact: true })).toBeFocused();
          await expect(editor).toHaveValue('Taking a break');
          await editor.fill('');
          await expect(editor).toHaveValue('');
          await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(status).toContainText('What are you up to?');
          expect(await page.evaluate(() => window.__e2eCommandPayloads)).toContainEqual({
            type: 'set_profile_field',
            field: 'm.status',
            value: null,
          });
        }
      });
    }

    test('a long status can be scrolled to its end', async ({ app, page, installRoomCore }) => {
      await page.addInitScript(() => {
        (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
          status: { text: 'A long status that wraps onto several lines. '.repeat(30), emoji: '💬' },
        };
      });
      await installRoomCore('ready');
      await app.openRoom('!room:example.test');
      await page.getByRole('button', { name: "Open Alice's profile" }).last().click();
      const status = page.locator('.profile-card-status-text');
      await expect(status).toBeVisible();

      expect(await status.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
        await status.evaluate((element) => element.clientHeight)
      );
      await status.hover();
      await page.mouse.wheel(0, 1000);
      await expect.poll(() => status.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      await status.focus();
      await page.keyboard.press('Control+End');
      await expect
        .poll(() =>
          status.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop
          )
        )
        .toBeLessThanOrEqual(1);
    });
  });
}
