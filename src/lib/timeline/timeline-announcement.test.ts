import { expect, test } from 'vitest';

import { previewMessage } from '#lib/features/room/timeline/preview-message.js';

import { arrivalAnnouncement, PREVIEW_LENGTH } from './timeline-announcement.js';

const t = (key: string, options?: Record<string, unknown>) =>
  `${key}:${Object.values(options ?? {}).join('|')}`;
const from = (body: string, name: string | null = 'Alice') =>
  previewMessage('a', body, { sender: '@a:x', sender_name: name });

test('a single arrival at the live edge reads sender and text', () => {
  expect(arrivalAnnouncement([from('hello\n  there')], true, t)).toBe(
    'timeline.newMessagePreview:Alice|hello there'
  );
});

test('the persona name wins over the account name', () => {
  const item = from('hi');
  item.per_message_profile = {
    id: null,
    display_name: 'Persona',
    avatar_url: null,
    pronouns: [],
  } as unknown as typeof item.per_message_profile;
  expect(arrivalAnnouncement([item], true, t)).toBe('timeline.newMessagePreview:Persona|hi');
});

test('long text is truncated', () => {
  const text = arrivalAnnouncement([from('x'.repeat(500))], true, t);
  expect(text).toBe(`timeline.newMessagePreview:Alice|${'x'.repeat(PREVIEW_LENGTH)}…`);
});

test('bursts and off-edge arrivals fall back to the count', () => {
  expect(arrivalAnnouncement([from('a'), from('b')], true, t)).toBe('timeline.newMessages:2');
  expect(arrivalAnnouncement([from('a')], false, t)).toBe('timeline.newMessages:1');
});

test('empty bodies fall back to the count', () => {
  expect(arrivalAnnouncement([from('   ')], true, t)).toBe('timeline.newMessages:1');
});
