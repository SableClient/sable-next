// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import EventTargetPreview from './EventTargetPreview.svelte';
import { TimelineEventIndex } from '../timeline/timeline-event-index';

test('a target names its sender in the colour of their profile', async () => {
  core.userProfile.mockImplementation(() =>
    Promise.resolve({ name_color_light: '#2244aa', name_color_dark: '#88aaff' })
  );
  const target = {
    id: 'pinned',
    event_id: '$pinned:example.org',
    sender: '@bob:example.org',
    sender_name: 'Bob',
    timestamp: 0,
    content: { kind: 'message', body: 'Pinned', html: null, emote: false, notice: false },
  } as unknown as TimelineItemView;
  const { container } = render(EventTargetPreview, {
    props: { eventId: '$pinned:example.org', events: new TimelineEventIndex([target], []) },
  });
  await tick();
  await tick();

  const preview = container.querySelector<HTMLElement>('.target-preview');
  expect(core.userProfile).toHaveBeenCalledWith('@bob:example.org');
  expect(preview?.classList.contains('tinted')).toBe(true);
  expect(preview?.style.getPropertyValue('--target-on-light')).not.toBe('');
  expect(preview?.style.getPropertyValue('--target-on-dark')).not.toBe('');
});
