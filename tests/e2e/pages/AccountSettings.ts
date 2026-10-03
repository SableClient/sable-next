import { expect, type Locator, type Page } from '@playwright/test';

import { COLD_BOOT_TIMEOUT } from './AppShell';

export class AccountSettings {
  readonly profile: Locator;
  readonly matrixId: Locator;
  readonly contacts: Locator;
  readonly blockedUsers: Locator;
  readonly displayName: Locator;
  readonly save: Locator;
  readonly cancel: Locator;

  constructor(private readonly page: Page) {
    this.profile = page.locator('h2#account-profile');
    this.matrixId = page.locator('h2#account-matrix-id');
    this.contacts = page.locator('h2#account-contact');
    this.blockedUsers = page.locator('h2#account-blocked');
    this.displayName = page.getByLabel('Display name');
    this.save = page.getByRole('button', { name: 'Save', exact: true });
    this.cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  }

  async open(): Promise<void> {
    await this.page.goto('/settings/account');
    await expect(this.profile).toBeVisible({ timeout: COLD_BOOT_TIMEOUT });
  }

  colorSwatch(label: string): Locator {
    return this.page.getByRole('button', { name: `Choose ${label}` });
  }

  colorPicker(): Locator {
    return this.page.locator('.color-popover');
  }

  colorValue(label: string): Locator {
    return this.page.getByLabel(`${label} hex value`);
  }
}
