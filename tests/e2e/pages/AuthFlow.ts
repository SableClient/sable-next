import type { Locator, Page } from '@playwright/test';

export class AuthFlow {
  readonly heading: Locator;
  readonly homeserver: Locator;
  readonly redirectSignInButton: Locator;
  readonly username: Locator;
  readonly password: Locator;
  readonly moreMethodsButton: Locator;
  readonly passwordSignInButton: Locator;
  readonly verificationCard: Locator;
  readonly leaveVerificationButton: Locator;
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
    // A first device comes back cross-signed, and that card offers Continue, not the skip.
    this.verificationCard = page.getByRole('form', { name: /Verify your device|Device verified/ });
    this.leaveVerificationButton = page
      .getByRole('button', { name: /Skip for now|Continue/ })
      .first();
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

  async signInWithPassword(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.passwordSignInButton.click();
  }
}
