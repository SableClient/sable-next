import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ app: { getAppPath: (): string => 'electron' } }));

vi.mock('electron', () => ({ app: mocks.app }));

import { installMethod } from './install-method';

beforeEach(() => {
  vi.stubEnv('FLATPAK_ID', '');
  vi.stubEnv('APPIMAGE', '');
  mocks.app.getAppPath = () => 'electron';
});

afterEach(() => vi.unstubAllEnvs());

test('Flatpak and AppImage are read from the environment', () => {
  vi.stubEnv('APPIMAGE', '/home/user/Sable.AppImage');
  expect(installMethod()).toBe('appimage');
  vi.stubEnv('FLATPAK_ID', 'moe.sable.client');
  expect(installMethod()).toBe('flatpak');
});

test.each([
  ['deb', 'deb'],
  ['rpm', 'rpm'],
  ['nix', 'distribution'],
])('a package-type of %s is a %s install', (type, method) => {
  const resources = mkdtempSync(join(tmpdir(), 'sable-install-'));
  writeFileSync(join(resources, 'package-type'), `${type}\n`);
  mocks.app.getAppPath = () => join(resources, 'app.asar');
  expect(installMethod()).toBe(method);
});

test('an install without a package-type file is unpacked', () => {
  expect(installMethod()).toBe('unpacked');
});
