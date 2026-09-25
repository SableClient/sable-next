import fixture from '../../src/lib/features/settings/verification-qr.fixture.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const ROOM_ID = '!room:example.test';

for (const viewport of [
  { name: 'desktop', size: { width: 1280, height: 800 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
]) {
  test(`the verification dialog shows a code to scan on ${viewport.name}`, async ({
    page,
    app,
    installRoomCore,
  }) => {
    await page.setViewportSize(viewport.size);
    await installRoomCore('ready');
    await app.openRoom(ROOM_ID);

    await page.evaluate((code) => {
      window.__e2eEmitTimelineEvent({
        type: 'verification',
        user_id: '@e2e:example.test',
        flow_id: 'e2e-flow',
        state: { phase: 'choose', qr: code, can_scan: true, can_compare: true },
      });
    }, fixture.code);

    const dialog = page.getByRole('dialog', { name: 'Device verification' });
    const code = dialog.getByRole('img', { name: 'Verification code' });
    await expect(code).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Compare emoji instead' })).toBeVisible();
    const box = await code.boundingBox();
    expect(box?.width).toBeGreaterThan(200);
    expect(box?.width).toBeCloseTo(box?.height ?? 0, 0);
    if (process.env.SABLE_E2E_SHOTS) {
      await page.screenshot({ path: test.info().outputPath(`qr-${viewport.name}.png`) });
    }
  });
}
