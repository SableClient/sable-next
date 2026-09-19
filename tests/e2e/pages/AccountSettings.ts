import type { Locator, Page } from '@playwright/test';

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
  readonly saveDisplayName: Locator;

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
    this.saveDisplayName = page
      .locator('.name-form')
      .getByRole('button', { name: 'Save', exact: true });
  }

  async open(): Promise<void> {
    await this.page.goto('/settings/account');
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

  colorSave(label: string): Locator {
    return this.page
      .locator('.color-setting')
      .filter({ has: this.page.getByText(label, { exact: true }) })
      .getByRole('button', { name: 'Save', exact: true });
  }
}
