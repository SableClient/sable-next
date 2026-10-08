import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

for (const mobile of [false, true]) {
  const prefix = mobile ? 'mobile ' : '';

  test(`${prefix}rich text formats text between markers`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: true }));
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');

    let sent = 0;
    for (const [delimiter, html] of [
      ['**', '<strong>test</strong>'],
      ['*', '<em>test</em>'],
      ['__', '<strong>test</strong>'],
      ['_', '<em>test</em>'],
      ['~~', '<del>test</del>'],
      ['||', '<span data-mx-spoiler="">test</span>'],
      ['`', '<code>test</code>'],
      ['``', '<code>test</code>'],
      ['***', '<strong><em>test</em></strong>'],
    ]) {
      await app.composer.click();
      await page.keyboard.type(delimiter + delimiter);
      for (let step = 0; step < delimiter.length; step += 1) await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('test');
      await expect(app.composer.locator('p').first()).toHaveJSProperty('innerHTML', html);
      await page.keyboard.press('Enter');
      sent += 1;
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__e2eCommandPayloads.filter((c) => c.type === 'send_message').length
          )
        )
        .toBe(sent);
      expect(
        await page.evaluate(() =>
          window.__e2eCommandPayloads.findLast((c) => c.type === 'send_message')
        )
      ).toMatchObject({ formatted: html });
      await expect(app.composer).toBeEmpty();
    }
  });

  test(`${prefix}Markdown mode sends escaped punctuation as literal text`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: false }));
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');

    for (const [source, formatted] of [
      ['\\*like so*', '<span>*</span>like so<span>*</span>'],
      ['\\`code\\`', '<span>`</span>code<span>`</span>'],
      ['\\$[unixtime 0]', '<span>$</span>[unixtime 0]'],
      ['**bold** and \\*literal*', '<strong>bold</strong> and <span>*</span>literal<span>*</span>'],
    ]) {
      await app.composer.click();
      await page.keyboard.type(source);
      await expect(app.composer).toHaveText(source);
      await page.keyboard.press('Enter');
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__e2eCommandPayloads.findLast((c) => c.type === 'send_message')
          )
        )
        .toMatchObject({ type: 'send_message', body: source, formatted });
      await expect(app.composer).toBeEmpty();
    }
  });

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

  test(`${prefix}leaving a block sends no blank lines or stray breaks`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: true }));
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    const newline = coarse ? 'Enter' : 'Shift+Enter';

    let sent = 0;
    for (const [keys, formatted] of [
      [['> quote', newline, newline, 'after'], '<blockquote><p>quote</p></blockquote><p>after</p>'],
      [['> quote', newline], '<blockquote><p>quote</p></blockquote>'],
      [['> quote', newline, newline], '<blockquote><p>quote</p></blockquote>'],
      [
        ['- one', newline, 'two', newline, newline, 'after'],
        '<ul><li>one</li><li>two</li></ul><p>after</p>',
      ],
      [['- one', newline, newline, newline], '<ul><li>one</li></ul>'],
    ] as const) {
      await app.composer.click();
      for (const key of keys) {
        if (key === newline) await page.keyboard.press(key);
        else await page.keyboard.type(key);
      }
      await app.sendMessage.click();
      sent += 1;
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__e2eCommandPayloads.filter((c) => c.type === 'send_message').length
          )
        )
        .toBe(sent);
      expect(
        await page.evaluate(() =>
          window.__e2eCommandPayloads.findLast((c) => c.type === 'send_message')
        ),
        keys.join(' ⏎ ')
      ).toMatchObject({ formatted });
      await expect(app.composer).toBeEmpty();
    }
  });

  test(`${prefix}vertical arrows stop on every blank line`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ richTextComposer: true }));
    });
    await installRoomCore('ready');
    await app.openRoom('!room:example.test');
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    const newline = coarse ? 'Enter' : 'Shift+Enter';

    await app.composer.click();
    for (const key of [
      '1',
      newline,
      newline,
      '2',
      newline,
      '3',
      newline,
      '4',
      newline,
      newline,
      '5',
    ]) {
      if (key === newline) await page.keyboard.press(key);
      else await page.keyboard.type(key);
    }
    const marked = async () => {
      await page.keyboard.type('X');
      const text = await app.composer
        .locator('p')
        .evaluate((p) =>
          [...p.childNodes]
            .map((node) =>
              node.nodeName === 'BR' &&
              !(node as Element).classList.contains('ProseMirror-trailingBreak')
                ? '|'
                : (node.textContent ?? '')
            )
            .join('')
        );
      await page.keyboard.press('Backspace');
      return text;
    };
    const up: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('ArrowUp');
      up.push(await marked());
    }
    expect(up[0]).toBe('1||2|3|4|X|5');
    expect(up[4]).toBe('1|X|2|3|4||5');
    for (let step = 0; step < 5; step += 1) await page.keyboard.press('ArrowDown');
    expect(await marked()).toBe('1||2|3|4|X|5');
  });
}
