// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const geolocation = vi.hoisted(() => ({
  currentFix: vi.fn(),
  locates: vi.fn(() => true),
}));

vi.mock('#lib/platform/geolocation.js', () => geolocation);
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));

import LocationComposer from './LocationComposer.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function render(onSend = vi.fn()): { instance: ReturnType<typeof mount>; onSend: typeof onSend } {
  const instance = mount(LocationComposer, {
    target: document.body,
    props: { open: true, onSend },
  });
  return { instance, onSend };
}

function field(id: string): HTMLInputElement {
  const element = document.querySelector(`#${id}`);
  if (!(element instanceof HTMLInputElement)) throw new Error(`${id} not found`);
  return element;
}

function fill(id: string, value: string): void {
  const input = field(id);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent.includes(label)
  );
  if (!found) throw new Error(`${label} not found`);
  return found;
}

test('sending stays disabled until the coordinates are in range', async () => {
  const { instance } = render();
  await tick();

  expect(button('composer.locationSend').disabled).toBe(true);

  fill('location-latitude', '48.8584');
  fill('location-longitude', '2.2945');
  await tick();

  expect(button('composer.locationSend').disabled).toBe(false);

  fill('location-latitude', '91');
  await tick();

  expect(button('composer.locationSend').disabled).toBe(true);
  await unmount(instance);
});

test('a label rides along, and the coordinates stand in when there is none', async () => {
  const { instance, onSend } = render();
  await tick();

  fill('location-latitude', '48.8584');
  fill('location-longitude', '2.2945');
  await tick();
  button('composer.locationSend').click();

  expect(onSend).toHaveBeenCalledWith('48.8584,2.2945', 'geo:48.8584,2.2945');
  await unmount(instance);
});

test('the current fix fills the fields', async () => {
  geolocation.currentFix.mockResolvedValue({
    kind: 'fix',
    fix: { latitude: 1.5, longitude: -2.5 },
  });
  const { instance } = render();
  await tick();

  button('composer.locationUseCurrent').click();
  await vi.waitFor(() => {
    expect(field('location-latitude').value).toBe('1.5');
  });

  expect(field('location-longitude').value).toBe('-2.5');
  await unmount(instance);
});

test('a refused fix leaves manual entry usable', async () => {
  geolocation.currentFix.mockResolvedValue({ kind: 'denied' });
  const { instance } = render();
  await tick();

  button('composer.locationUseCurrent').click();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'composer.locationDenied'
    );
  });

  fill('location-latitude', '1');
  fill('location-longitude', '2');
  await tick();

  expect(button('composer.locationSend').disabled).toBe(false);
  await unmount(instance);
});

test('a webview without geolocation offers no button for it', async () => {
  geolocation.locates.mockReturnValue(false);
  const { instance } = render();
  await tick();

  expect(document.body.textContent).not.toContain('composer.locationUseCurrent');
  await unmount(instance);
});
