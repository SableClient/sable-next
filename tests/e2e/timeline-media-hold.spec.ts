import { expect, test, SIGNED_OUT } from './fixtures/test';
import { historyItems, timelineItem } from './fixtures/timeline-items';
import type { TimelineItemView } from '#src/generated/protocol';
import { nextFrames } from './fixtures/settle';

test.use({ storageState: SIGNED_OUT });

const EMOTES_PER_MESSAGE = 8;

function voiceMessage(id: string): TimelineItemView {
  return {
    ...timelineItem(id, 'voice.ogg'),
    content: {
      kind: 'audio',
      filename: 'voice.ogg',
      caption: null,
      html: null,
      source: JSON.stringify({ Plain: `mxc://example.test/${id}` }),
      mime: 'audio/ogg',
      duration_ms: 4000,
      waveform: [1, 2, 3, 4],
      voice: true,
      metadata: null,
    },
  };
}

test('a voice message keeps its player when a message arrives past the media url cap', async ({
  app,
  timeline,
  core,
  installRoomCore,
  page,
}) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'reset',
      values: [
        ...historyItems({
          idPrefix: 'emotes',
          label: 'Emotes',
          count: 10,
          timestampBase: 1_699_999_000_000,
          body: (index) =>
            Array.from(
              { length: EMOTES_PER_MESSAGE },
              (_, emote) =>
                `<img data-mx-emoticon height="32" alt=":e${String(index)}_${String(emote)}:" src="mxc://example.test/emote-${String(index)}-${String(emote)}">`
            ).join(''),
        }),
        voiceMessage('voice'),
      ],
    },
  ]);
  await expect.poll(() => page.locator('img[src^="blob:"]').count()).toBeGreaterThan(64);
  const audio = timeline.itemById('voice').locator('audio');
  await expect(audio).toHaveAttribute('src', /^blob:/);
  const src = await audio.getAttribute('src');
  await audio.evaluate((node) => {
    (node as HTMLAudioElement & { held?: boolean }).held = true;
  });

  await core.emitTimelineDiff(subscription, [
    { op: 'push_back', value: timelineItem('arrival', 'A new message') },
  ]);
  await expect(timeline.itemById('arrival')).toBeAttached();
  await nextFrames(page, 30);

  expect(await audio.evaluate((node) => (node as HTMLAudioElement & { held?: boolean }).held)).toBe(
    true
  );
  await expect(audio).toHaveAttribute('src', src ?? '');
});
