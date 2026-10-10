import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import { core } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import PushGateway from './PushGateway.svelte';

const GATEWAY = 'https://sygnal.example.test/_matrix/push/v1/notify';

afterEach(() => {
  setPreference('pushGatewayUrl', '');
  setPreference('pushVapidKey', '');
  setPreference('pushAppId', '');
  localStorage.removeItem('sable-preferences');
});

async function mount() {
  Object.assign(core, { webPusherSupport: vi.fn().mockResolvedValue({ vapid: null }) });
  core.commands = core;
  const screen = await render(PushGateway);
  return {
    screen,
    url: screen.getByLabelText('Gateway URL'),
    vapid: screen.getByLabelText('VAPID public key'),
    appId: screen.getByLabelText('Application ID'),
    apply: screen.getByRole('button', { name: 'Apply' }),
    reset: screen.getByRole('button', { name: 'Use the default' }),
  };
}

function storedOverride() {
  const raw = localStorage.getItem('sable-preferences');
  const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  return {
    pushGatewayUrl: parsed.pushGatewayUrl ?? '',
    pushVapidKey: parsed.pushVapidKey ?? '',
    pushAppId: parsed.pushAppId ?? '',
  };
}

const EMPTY = { pushGatewayUrl: '', pushVapidKey: '', pushAppId: '' };

test('the deployment default holds until all three fields are applied', async () => {
  const { screen, url, vapid, appId, apply } = await mount();
  await expect.element(url).toBeVisible();
  await expect.element(screen.getByText(/Using https:\/\//)).toBeVisible();

  await userEvent.fill(url.element(), GATEWAY);
  await expect.element(screen.getByText(/Fill in all three/)).toBeVisible();
  await expect.element(apply).toBeDisabled();
  expect(storedOverride()).toEqual(EMPTY);

  await userEvent.fill(vapid.element(), 'BCnS4SbHje');
  await userEvent.fill(appId.element(), 'org.example.web');
  await expect.element(apply).toBeEnabled();
  expect(storedOverride()).toEqual(EMPTY);

  await userEvent.click(apply);
  expect(storedOverride()).toEqual({
    pushGatewayUrl: GATEWAY,
    pushVapidKey: 'BCnS4SbHje',
    pushAppId: 'org.example.web',
  });
  await expect.element(apply).toBeDisabled();
});

test('an address the core would refuse cannot be applied', async () => {
  const { url, vapid, appId, apply } = await mount();
  await expect.element(url).toBeVisible();
  await userEvent.fill(vapid.element(), 'BCnS4SbHje');
  await userEvent.fill(appId.element(), 'org.example.web');

  for (const refused of [
    'http://sygnal.example.test/_matrix/push/v1/notify',
    'https://sygnal.example.test/',
    'not a url',
  ]) {
    await userEvent.fill(url.element(), refused);
    await expect.element(apply).toBeDisabled();
    await expect.element(url).toHaveAttribute('aria-invalid', 'true');
  }

  await userEvent.fill(url.element(), GATEWAY);
  await expect.element(apply).toBeEnabled();
  await expect.element(url).not.toHaveAttribute('aria-invalid', 'true');
});

test('the default comes back on reset', async () => {
  const { screen, url, vapid, appId, apply, reset } = await mount();
  await userEvent.fill(url.element(), GATEWAY);
  await userEvent.fill(vapid.element(), 'BCnS4SbHje');
  await userEvent.fill(appId.element(), 'org.example.web');
  await userEvent.click(apply);

  await userEvent.click(reset);
  expect(storedOverride()).toEqual(EMPTY);
  await expect.element(url).toHaveValue('');
  await expect.element(screen.getByText(/Using https:\/\//)).toBeVisible();
});
