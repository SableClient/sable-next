import { expect, test } from 'vitest';

import { TIMELINE_LAYOUT_STYLE } from './timeline-layout';

test('publishes media dimensions as inherited CSS properties', () => {
  expect(TIMELINE_LAYOUT_STYLE).toBe('--timeline-media-max:25rem;--timeline-sticker-width:9.5rem');
});
