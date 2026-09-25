import { expect, type Locator, type Page } from '@playwright/test';

import { COLD_BOOT_TIMEOUT } from './AppShell';

export class AccountSettings {
  readonly profile: Locator;
  readonly status: Locator;
  readonly colors: Locator;
  readonly identity: Locator;
  readonly biography: Locator;
  readonly animal: Locator;
  readonly matrixId: Locator;
  readonly contacts: Locator;
  readonly blockedUsers: Locator;
  readonly displayName: Locator;

  constructor(private readonly page: Page) {
    this.profile = page.locator('h2#account-profile');
    this.status = page.locator('h2#profile-status');
    this.colors = page.locator('h2#profile-colors');
    this.identity = page.locator('h2#profile-identity');
    this.biography = page.locator('h2#profile-bio');
    this.animal = page.locator('h2#profile-animal');
    this.matrixId = page.locator('h2#account-matrix-id');
    this.contacts = page.locator('h2#account-contact');
    this.blockedUsers = page.locator('h2#account-blocked');
    this.displayName = page.getByLabel('Display name');
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
