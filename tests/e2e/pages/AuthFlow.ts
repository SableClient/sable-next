import { expect, type Locator, type Page } from '@playwright/test';

export class AuthFlow {
  readonly heading: Locator;
  readonly homeserver: Locator;
  readonly redirectSignInButton: Locator;
  readonly username: Locator;
  readonly password: Locator;
  readonly moreMethodsButton: Locator;
  readonly passwordSignInButton: Locator;
  readonly setupCard: Locator;
  readonly previousStageButton: Locator;
  readonly nextStageButton: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.homeserver = page.getByLabel('Account provider');
    this.redirectSignInButton = page.getByRole('button', { name: /^Sign in with http/ });
    this.username = page.getByLabel('Username');
    this.password = page.getByRole('textbox', { name: 'Password' });
    this.moreMethodsButton = page.getByRole('button', { name: 'More ways to sign in' });
    this.passwordSignInButton = page.getByRole('button', { name: 'Sign in with password' });
    this.setupCard = page.locator('.auth-card.active');
    this.previousStageButton = page.getByRole('button', { name: 'Back' });
    this.nextStageButton = page.getByRole('button', { name: 'Next' });
  }

  async open(homeserver?: string): Promise<void> {
    const path = homeserver ? `/login?server=${encodeURIComponent(homeserver)}` : '/login';
    await this.page.goto(path);
  }

  async revealMoreMethods(): Promise<void> {
    await this.moreMethodsButton.click();
  }

  async revealPasswordLogin(): Promise<void> {
    await this.revealMoreMethods();
    await this.passwordSignInButton.click();
  }

  async finishSetup(): Promise<void> {
    const rooms = /\/rooms$/;
    for (let step = 0; step < 12; step += 1) {
      await expect(this.page).toHaveURL(/\/(setup\/[a-z]+|rooms)$/, { timeout: 30_000 });
      if (rooms.test(new URL(this.page.url()).pathname)) return;
      const before = this.page.url();
      await this.setupCard
        .getByRole('button', {
          name: /^(Skip anyway|Skip for now|Not now|Continue|Go to your chats)$/,
        })
        .first()
        .click();
      await this.page
        .waitForURL((url) => url.href !== before, { timeout: 5_000 })
        .catch(() => undefined);
    }
    await expect(this.page).toHaveURL(rooms);
  }

  async signInWithPassword(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.passwordSignInButton.click();
  }
}
