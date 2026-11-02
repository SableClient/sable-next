import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import TooltipHostHarness from './TooltipHostHarness.test.svelte';

const contents = () => document.querySelectorAll('[data-tooltip-content]');

test('triggers below a host open the shared tooltip with their own content, built on open', async () => {
  const format = vi.fn(() => 'Second');
  await render(TooltipHostHarness, { format });

  await userEvent.hover(page.getByRole('button', { name: 'First' }));
  await vi.waitFor(() => {
    expect(contents()[0]).toHaveTextContent('First');
  });
  expect(format).not.toHaveBeenCalled();

  await userEvent.hover(page.getByText('Two'));
  await vi.waitFor(() => {
    expect(contents()[0]).toHaveTextContent('Second');
  });
  expect(contents()).toHaveLength(1);
});

test('a trigger whose tooltip is disabled stays clickable', async () => {
  const onclick = vi.fn();
  await render(TooltipHostHarness, { format: () => '', onclick });

  await userEvent.click(page.getByRole('button', { name: 'Three' }));
  expect(onclick).toHaveBeenCalledOnce();
});
