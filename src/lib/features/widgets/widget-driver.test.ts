import { expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { SableWidgetDriver } from './widget-driver.js';

test('returns the created IDs for messages, state events and redactions', async () => {
  const commands = {
    sendRawEvent: vi.fn().mockResolvedValue('$message'),
    sendStateEvent: vi.fn().mockResolvedValue('$state'),
    sendRedaction: vi.fn().mockResolvedValue('$redaction'),
  };
  const driver = new SableWidgetDriver(
    { commands } as unknown as CoreClient,
    '!room:example.org',
    (caps) => Promise.resolve(caps)
  );
  await expect(driver.sendEvent('com.example.message', {})).resolves.toEqual({
    roomId: '!room:example.org',
    eventId: '$message',
  });
  await expect(
    driver.sendEvent('com.example.state', {}, '', '!other:example.org')
  ).resolves.toEqual({ roomId: '!other:example.org', eventId: '$state' });
  await expect(
    driver.sendEvent('m.room.redaction', { redacts: '$target', reason: 'removed' })
  ).resolves.toEqual({ roomId: '!room:example.org', eventId: '$redaction' });
  expect(commands.sendRedaction).toHaveBeenCalledExactlyOnceWith(
    '!room:example.org',
    '$target',
    'removed'
  );
  await expect(driver.sendEvent('m.room.redaction', { redacts: 1 })).rejects.toThrow(
    'redaction without a target'
  );
  expect(commands.sendRedaction).toHaveBeenCalledTimes(1);
});
