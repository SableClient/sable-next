import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import Select from './Select.svelte';

const items = [
  { value: 'system', label: 'System default' },
  { value: 'speakers', label: 'USB Audio Speakers' },
  {
    value: 'hdmi',
    label: 'GB202 High Definition Audio Controller Digital Stereo (HDMI)',
  },
  { value: 'headset', label: 'CORSair VIRTUOSO XT Wireless Gaming Headset' },
  { value: 'receiver', label: 'Receiver Analog USB Audio S/PDIF Stereo Output' },
];

test('options keep their height when the popup is clipped', async () => {
  await page.viewport(1280, 800);
  await render(Select, { items, value: 'system', 'aria-label': 'Speaker' });
  const trigger = page.getByLabelText('Speaker').element();
  (trigger.parentElement as HTMLElement).style.width = '210px';
  await userEvent.click(page.getByLabelText('Speaker'));

  const options = page.getByRole('option');
  await expect.element(options.first()).toBeVisible();
  (document.querySelector('.menu-surface') as HTMLElement).style.height = '120px';

  const boxes = options.all().map((option) => {
    const element = option.element() as HTMLElement;
    const label = element.querySelector('.selection-label') as HTMLElement;
    const box = element.getBoundingClientRect();
    return { height: box.height, top: box.top, bottom: box.bottom, label: label.scrollHeight };
  });

  for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(box.label);
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index].top).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 0.5);
  }
});

test('shows the label of an item whose value is empty', async () => {
  await page.viewport(1280, 800);
  await render(Select, {
    items: [{ value: '', label: 'Server default' }, ...items],
    value: '',
    'aria-label': 'Version',
  });

  await expect.element(page.getByLabelText('Version')).toHaveTextContent('Server default');
});
