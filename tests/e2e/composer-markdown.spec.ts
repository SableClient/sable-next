import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

for (const mobile of [false, true]) {
  const prefix = mobile ? 'mobile ' : '';

  test(`${prefix}typed Markdown handles formatting and literal delimiters`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: true }));
    });
    await installRoomCore('ready');

    for (const [input, html] of [
      ['say ***both*** now', 'say <strong><em>both</em></strong> now'],
      ['__bold__ next', '<strong>bold</strong> next'],
      ['**a*b** next', '<strong>a*b</strong> next'],
      ['\\*literal\\*', '\\*literal\\*'],
      ['---literal', '---literal'],
      ['[label](https://example.org)', '<a href="https://example.org">label</a>'],
      ['``code ` tick`` next', '<code>code ` tick</code> next'],
      ['`code``', '`code``'],
      ['**a `b` c** next', '<strong>a </strong><code>b</code><strong> c</strong> next'],
    ]) {
      await app.openRoom('!room:example.test');
      await app.composer.click();
      await page.keyboard.type(input);
      await expect(app.composer.locator('p').first()).toHaveJSProperty('innerHTML', html);
    }
  });

  test(`${prefix}code fences preserve newlines and indentation`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: true }));
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    await app.composer.click();
    await page.keyboard.type('```rust');
    await expect(app.composer).toHaveText('```rust');
    await page.keyboard.press('Shift+Enter');
    const code = app.composer.locator('pre code');
    await expect(app.composer.locator('pre')).toBeVisible();
    await page.keyboard.type('fn main() {');
    await page.keyboard.press('Shift+Enter');
    await expect(code).toHaveJSProperty('textContent', 'fn main() {\n');
    await page.keyboard.type('    let x = 1;');
    await page.keyboard.press('Shift+Enter');
    await expect(code).toHaveJSProperty('textContent', 'fn main() {\n    let x = 1;\n');
    await page.keyboard.type('}');
    await page.keyboard.press('Shift+Enter');
    await expect(code).toHaveJSProperty('textContent', 'fn main() {\n    let x = 1;\n}\n');
    await page.keyboard.type('```');
    await page.keyboard.press('Shift+Enter');
    await expect(code).toHaveJSProperty('textContent', 'fn main() {\n    let x = 1;\n}');
    await page.keyboard.type('after');

    await expect(code).toHaveJSProperty('textContent', 'fn main() {\n    let x = 1;\n}');
    await expect(app.composer.locator('p').last()).toHaveText('after');
  });
}
