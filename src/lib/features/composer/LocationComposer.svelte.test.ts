// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

const geolocation = vi.hoisted(() => ({
  currentFix: vi.fn(),
  locates: vi.fn(() => true),
  locationOffered: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('#lib/platform/geolocation.js', () => geolocation);
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import LocationComposer from './LocationComposer.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

async function setup(onSend = vi.fn()) {
  render(LocationComposer, { open: true, onSend });
  await screen.findByRole('dialog');
  return { user: userEvent.setup(), onSend };
}

const latitude = () => screen.getByRole('textbox', { name: 'composer.locationLatitude' });
const longitude = () => screen.getByRole('textbox', { name: 'composer.locationLongitude' });
const send = () => screen.getByRole('button', { name: 'composer.locationSend' });
const useCurrent = () => screen.queryByRole('button', { name: /composer\.locationUseCurrent/ });

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  value: string
): Promise<void> {
  await user.clear(field);
  await user.type(field, value);
}

test('sending stays disabled until the coordinates are in range', async () => {
  const { user } = await setup();

  expect(send()).toBeDisabled();

  await fill(user, latitude(), '48.8584');
  await fill(user, longitude(), '2.2945');

  expect(send()).toBeEnabled();

  await fill(user, latitude(), '91');

  expect(send()).toBeDisabled();
});

test('a label rides along, and the coordinates stand in when there is none', async () => {
  const { user, onSend } = await setup();

  await fill(user, latitude(), '48.8584');
  await fill(user, longitude(), '2.2945');
  await user.click(send());

  expect(onSend).toHaveBeenCalledWith('48.8584,2.2945', 'geo:48.8584,2.2945');
});

test('the current fix fills the fields', async () => {
  geolocation.currentFix.mockResolvedValue({
    kind: 'fix',
    fix: { latitude: 1.5, longitude: -2.5 },
  });
  const { user } = await setup();

  const current = useCurrent();
  if (!current) throw new Error('no current-location button');
  await user.click(current);
  await vi.waitFor(() => {
    expect(latitude()).toHaveValue('1.5');
  });

  expect(longitude()).toHaveValue('-2.5');
});

test('a refused fix leaves manual entry usable', async () => {
  geolocation.currentFix.mockResolvedValue({ kind: 'denied' });
  const { user } = await setup();

  const current = useCurrent();
  if (!current) throw new Error('no current-location button');
  await user.click(current);
  expect(await screen.findByRole('alert')).toHaveTextContent('composer.locationDenied');

  await fill(user, latitude(), '1');
  await fill(user, longitude(), '2');

  expect(send()).toBeEnabled();
});

test('a webview without geolocation offers no button for it', async () => {
  geolocation.locates.mockReturnValue(false);
  geolocation.locationOffered.mockResolvedValue(false);
  await setup();

  expect(useCurrent()).not.toBeInTheDocument();
});

test('a build without the native plugin takes the button back once it knows', async () => {
  geolocation.locationOffered.mockResolvedValue(false);
  await setup();

  await vi.waitFor(() => {
    expect(useCurrent()).not.toBeInTheDocument();
  });
});
