import { expect, SIGNED_OUT, test } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('code pasted from an editor keeps its lines and indentation in plain mode', async ({
  page,
  app,
  timeline,
  installRoomCore,
  browserName,
}) => {
  test.skip(browserName === 'firefox', 'a synthetic paste carries no clipboard data in Firefox');
  await installRoomCore('ready');
  await app.openRooms();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();
  await app.composer.click();
  await page.keyboard.type('```');
  await page.keyboard.press('Shift+Enter');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'fn main() {\n    let x = 1;\n}');
    data.setData(
      'text/html',
      '<div><div><span>fn main() {</span></div><div><span>    let x = 1;</span></div><div><span>}</span></div></div>'
    );
    document
      .querySelector('[role="combobox"]')
      ?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      );
  });

  await expect.poll(() => app.composer.innerText()).toBe('```\nfn main() {\n    let x = 1;\n}');
});
