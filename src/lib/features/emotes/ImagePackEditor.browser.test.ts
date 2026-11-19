import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

import type { ImagePackView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import ImagePackEditor from './ImagePackEditor.svelte';

const pack: ImagePackView = {
  id: 'many',
  origin: 'room',
  room_id: '!r:example.org',
  name: 'Many',
  avatar_url: null,
  declared_name: 'Many',
  declared_avatar_url: null,
  attribution: null,
  usage: ['emoticon'],
  stable_event: true,
  legacy_event: false,
  images: Array.from({ length: 500 }, (_, index) => ({
    shortcode: `emote${index}`,
    url: `mxc://a/emote${index}`,
    body: null,
    usage: ['emoticon'],
    info: null,
    source_pack: null,
  })),
};

test('scrolling the host brings later images into the list and drops the early ones', async () => {
  const scroll = document.createElement('div');
  scroll.style.cssText = 'height: 600px; overflow-y: auto;';
  document.body.append(scroll);
  await render(ImagePackEditor, { props: { pack, canEdit: true }, target: scroll });

  await expect.poll(() => scroll.querySelectorAll('li.setting-row').length).toBeGreaterThan(0);
  expect(scroll.querySelectorAll('li.setting-row').length).toBeLessThan(80);
  expect(scroll.textContent).not.toContain(':emote499:');

  scroll.scrollTop = scroll.scrollHeight;

  await expect.poll(() => scroll.textContent).toContain(':emote499:');
  expect(scroll.textContent).not.toContain(':emote0:');
  expect(scroll.querySelectorAll('li.setting-row').length).toBeLessThan(80);
});
