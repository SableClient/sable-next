import type { Locator, Page } from '@playwright/test';

export class AuthFlow {
  readonly heading: Locator;
  readonly username: Locator;
  readonly password: Locator;
  readonly moreMethodsButton: Locator;
  readonly passwordSignInButton: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.username = page.getByLabel('Username');
    this.password = page.getByRole('textbox', { name: 'Password' });
    this.moreMethodsButton = page.getByRole('button', { name: 'More ways to sign in' });
    this.passwordSignInButton = page.getByRole('button', { name: 'Sign in with password' });
  }

  async open(homeserver?: string): Promise<void> {
    const path = homeserver ? `/login?server=${encodeURIComponent(homeserver)}` : '/login';
    await this.page.goto(path);
  }

  async revealPasswordLogin(): Promise<void> {
    await this.moreMethodsButton.click();
    await this.passwordSignInButton.click();
  }

  async signInWithPassword(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.passwordSignInButton.click();
  }
}
