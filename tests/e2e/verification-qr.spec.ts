import type { VerificationView } from '#src/generated/protocol';

import fixture from '../../src/lib/features/settings/verification-qr.fixture.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const ROOM_ID = '!room:example.test';

test('QR verification completes and resets on touch devices', async ({
  page,
  app,
  installRoomCore,
}) => {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = matchMedia(query);
      if (query === '(pointer: coarse)') Object.defineProperty(result, 'matches', { value: true });
      return result;
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        enumerateDevices: () => Promise.resolve([{ kind: 'videoinput' }]),
        getUserMedia: () => new Promise(() => {}),
      },
    });
  });
  await installRoomCore('ready');
  await app.openRoom(ROOM_ID);

  const emitVerification = (state: VerificationView, flowId = 'qr-scan-flow') =>
    page.evaluate(
      ({ state, flowId }) => {
        window.__e2eEmitTimelineEvent({
          type: 'verification',
          user_id: '@e2e:example.test',
          flow_id: flowId,
          state,
        });
      },
      { state, flowId }
    );

  await emitVerification({ phase: 'choose', qr: fixture.code, can_scan: true, can_compare: true });

  const dialog = page.getByRole('dialog', { name: 'Device verification' });
  const scanner = dialog.getByLabel('Looking for a code…');
  const qr = dialog.getByRole('img', { name: 'Verification code' });
  await expect(scanner).toBeVisible();
  await expect(qr).toHaveCount(0);
  await dialog.getByRole('button', { name: "Show this device's code" }).click();
  await expect(qr).toBeVisible();

  await emitVerification({ phase: 'reciprocated' });
  await expect(dialog.getByText('Code scanned. Confirm on your other device.')).toBeVisible();
  await expect(qr).toHaveCount(0);
  await expect(scanner).toHaveCount(0);

  await emitVerification({ phase: 'done' });
  await expect(dialog.getByText('Your device is verified.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  await emitVerification(
    { phase: 'choose', qr: fixture.code, can_scan: true, can_compare: true },
    'qr-next-flow'
  );
  await expect(scanner).toBeVisible();
  await expect(qr).toHaveCount(0);
});
