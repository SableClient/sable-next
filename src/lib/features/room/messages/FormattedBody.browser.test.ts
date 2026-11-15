import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import FormattedBody from './FormattedBody.svelte';
import { core } from '#lib/core/__mocks__/context.js';

test.each(['em', 'i'])('custom emoji slant inside %s', async (tag) => {
  core.fetchMedia.mockResolvedValue(
    Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYFvXsPwAGNgLW0emd+QAAAABJRU5ErkJggg=='
      ),
      (char) => char.charCodeAt(0)
    )
  );
  const image = (alt: string) => `<img data-mx-emoticon src="mxc://example.org/wave" alt="${alt}">`;
  const screen = await render(FormattedBody, {
    html: `<${tag}>${image(':italic:')}</${tag}> ${image(':plain:')}`,
  });
  const italic = screen.getByRole('img', { name: ':italic:' });
  const plain = screen.getByRole('img', { name: ':plain:' });
  await expect.element(italic).toBeVisible();
  const skew = new DOMMatrix(getComputedStyle(italic.element()).transform);
  expect(skew.c).toBeCloseTo(Math.tan((-10 * Math.PI) / 180));
  expect(getComputedStyle(plain.element()).transform).toBe('none');
});
