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
  await dialog.getByRole('button', { name: 'Show this device’s code' }).click();
  await expect(qr).toBeVisible();

  await emitVerification({ phase: 'reciprocated' });
  await expect(dialog.getByText('Code scanned. Confirm on your other device.')).toBeVisible();
  await expect(qr).toHaveCount(0);
  await expect(scanner).toHaveCount(0);

  await emitVerification({ phase: 'done' });
  await expect(dialog.getByText('Your device is verified.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();

  await emitVerification(
    { phase: 'choose', qr: fixture.code, can_scan: true, can_compare: true },
    'qr-next-flow'
  );
  await expect(scanner).toBeVisible();
  await expect(qr).toHaveCount(0);
});

test('the verification dialog moves focus to its title in each phase', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom(ROOM_ID);

  const emit = (state: VerificationView) =>
    page.evaluate((state) => {
      window.__e2eEmitTimelineEvent({
        type: 'verification',
        user_id: '@e2e:example.test',
        flow_id: 'focus-flow',
        state,
      });
    }, state);

  await emit({ phase: 'choose', qr: null, can_scan: false, can_compare: true });
  const dialog = page.getByRole('dialog', { name: 'Device verification' });
  const title = dialog.getByRole('heading', { name: 'Device verification' });
  const status = dialog.getByRole('status');
  await expect(dialog).toBeVisible();

  await emit({ phase: 'waiting' });
  await expect(title).toBeFocused();
  await expect(status).toHaveText('Waiting for the other device…');

  await page.getByRole('button', { name: 'Cancel verification' }).focus();
  await emit({
    phase: 'compare',
    emojis: [
      { symbol: '🐶', description: 'Dog' },
      { symbol: '🐱', description: 'Cat' },
    ],
    decimals: [1, 2, 3],
  });
  await expect(title).toBeFocused();
  await expect(dialog.getByRole('group', { name: 'Verification emoji' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Dog' })).toBeVisible();

  await emit({ phase: 'done' });
  await expect(title).toBeFocused();
  await expect(status).toHaveText('Your device is verified.');
});
