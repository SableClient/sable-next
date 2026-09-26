import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const CASES = [
  { scheme: 'light', hero: '#1b1b3a', brightness: 'dark' },
  { scheme: 'dark', hero: '#f4e7c8', brightness: 'light' },
] as const;

for (const { scheme, hero, brightness } of CASES) {
  test(`a ${brightness} profile card keeps its text legible on the ${scheme} theme`, async ({
    app,
    page,
    installRoomCore,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript(
      (patch) => {
        (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = patch;
      },
      {
        hero_color: hero,
        hero_brightness: brightness,
        bio: 'Hello <a href="https://example.org">link</a> <code>code</code>',
        pronouns: [{ summary: 'they/them', language: 'en' }],
        timezone: 'Europe/Paris',
        extra: [{ key: 'io.example.thing', value: 'x' }],
      }
    );
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await page.getByRole('button', { name: "Open Alice's profile" }).last().click();
    const card = page.locator('.profile-card');
    await expect(card.getByText('Show misc. data', { exact: false })).toBeVisible();

    const illegible = await card.evaluate((root) => {
      const probe = document.createElement('canvas').getContext('2d');
      if (!probe) throw new Error('no canvas');
      const luminance = (color: string) => {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = color;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...probe.getImageData(0, 0, 1, 1).data].map((value) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const background = (element: Element | null): string => {
        for (let node = element; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
        }
        return 'white';
      };
      const failures: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement;
        const text = node.textContent?.trim();
        if (!element || !text || element.closest('.avatar-root, input')) continue;
        const fg = luminance(getComputedStyle(element).color);
        const bg = luminance(background(element));
        const contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (contrast < 3) failures.push(`${text} (${contrast.toFixed(2)})`);
      }
      return failures;
    });
    expect(illegible).toEqual([]);
  });
}
