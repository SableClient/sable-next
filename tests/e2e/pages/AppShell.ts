import { expect, type Locator, type Page } from '@playwright/test';

const COLD_BOOT_TIMEOUT = 15_000;

export class AppShell {
  readonly primaryNavigation: Locator;
  readonly quickTools: Locator;
  readonly mobileQuickTools: Locator;
  readonly startupStatus: Locator;
  readonly startupHeading: Locator;
  readonly startupError: Locator;
  readonly retryButton: Locator;
  readonly backToRooms: Locator;
  readonly resizeRooms: Locator;
  readonly composer: Locator;
  readonly sendMessage: Locator;
  readonly createRoomName: Locator;
  readonly createRoomSubmit: Locator;
  readonly closeSettings: Locator;
  readonly deviceBanner: Locator;

  constructor(private readonly page: Page) {
    this.primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
    this.quickTools = page.getByRole('navigation', { name: 'Quick tools' });
    this.mobileQuickTools = page
      .locator('.navigation-panel')
      .getByRole('navigation', { name: 'Quick tools' });
    // Scoped to the page: root-layout banners are live regions too.
    this.startupStatus = page.getByRole('main').getByRole('status');
    this.startupHeading = page.getByRole('heading', { name: 'Starting Sable' });
    this.startupError = page.getByRole('alert');
    this.retryButton = page.getByRole('button', { name: 'Try again' });
    this.backToRooms = page.getByRole('button', { name: 'Back to rooms' });
    this.resizeRooms = page.getByRole('slider', { name: 'Resize rooms' });
    this.composer = page.getByRole('combobox', { name: 'Send a message...' });
    this.sendMessage = page.getByRole('button', { name: 'Send message' });
    this.createRoomName = page.getByLabel('Name');
    this.createRoomSubmit = page.getByRole('button', { name: 'Create room', exact: true });
    this.closeSettings = page.getByRole('button', { name: 'Close' });
    this.deviceBanner = page.getByRole('status', { name: /not verified/i });
  }

  async openHome(): Promise<void> {
    await this.page.goto('/home');
  }

  async openInbox(): Promise<void> {
    await this.page.goto('/inbox');
  }

  async openCreateRoom(): Promise<void> {
    await this.page.goto('/create-room');
  }

  async openRoom(roomId: string, { settled = true } = {}): Promise<void> {
    await this.page.goto(`/home/${encodeURIComponent(roomId)}`);
    if (settled) await this.awaitTimelineSettled();
  }

  async openPermalink(roomId: string, eventId: string): Promise<void> {
    await this.page.goto(
      `/home/${encodeURIComponent(roomId)}?event=${encodeURIComponent(eventId)}`
    );
    await this.awaitTimelineSettled();
  }

  async dismissDeviceBanner(): Promise<void> {
    await this.deviceBanner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(this.deviceBanner).toHaveCount(0);
  }

  private async awaitTimelineSettled(): Promise<void> {
    await expect(this.page.locator('.timeline-viewport:not(.initial)')).toBeVisible({
      timeout: COLD_BOOT_TIMEOUT,
    });
  }

  /** The `/to/...` funnel external links and notifications go through. */
  async openMatrixToLink(roomId: string, eventId?: string): Promise<void> {
    const fragment = eventId
      ? `${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`
      : encodeURIComponent(roomId);
    await this.page.goto(`/to/${fragment}`);
  }

  homeLink(): Locator {
    return this.primaryNavigation.getByRole('link', { name: 'Home' });
  }

  roomLink(name: string): Locator {
    return this.page.getByRole('link', { name });
  }

  roomHeading(name: string): Locator {
    return this.page.getByRole('heading', { name });
  }

  async openRoomFromList(name: string): Promise<void> {
    await this.roomLink(name).click();
  }
}
