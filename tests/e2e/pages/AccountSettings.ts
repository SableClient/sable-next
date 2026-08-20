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
    this.profile = page.getByRole('heading', { name: 'Profile', exact: true });
    this.status = page.getByRole('heading', { name: 'Status' });
    this.colors = page.getByRole('heading', { name: 'Profile colors' });
    this.identity = page.getByRole('heading', { name: 'Pronouns and timezone' });
    this.biography = page.getByRole('heading', { name: 'Biography' });
    this.animal = page.getByRole('heading', { name: 'Animal cosmetics' });
    this.matrixId = page.getByRole('heading', { name: 'Matrix ID' });
    this.contacts = page.getByRole('heading', { name: 'Contact information' });
    this.blockedUsers = page.getByRole('heading', { name: 'Blocked users' });
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
