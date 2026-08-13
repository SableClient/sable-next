import type { Locator, Page } from '@playwright/test';

export class AppShell {
  readonly primaryNavigation: Locator;
  readonly quickTools: Locator;
  readonly startupStatus: Locator;
  readonly startupHeading: Locator;
  readonly startupError: Locator;
  readonly retryButton: Locator;

  constructor(private readonly page: Page) {
    this.primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
    this.quickTools = page.getByRole('navigation', { name: 'Quick tools' });
    this.startupStatus = page.getByRole('status');
    this.startupHeading = page.getByRole('heading', { name: 'Starting Sable' });
    this.startupError = page.getByRole('alert');
    this.retryButton = page.getByRole('button', { name: 'Try again' });
  }

  async openHome(): Promise<void> {
    await this.page.goto('/home');
  }

  homeLink(): Locator {
    return this.primaryNavigation.getByRole('link', { name: 'Home' });
  }
}
