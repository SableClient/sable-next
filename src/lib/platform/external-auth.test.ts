import { beforeEach, describe, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  platform: vi.fn(() => 'ios'),
  electronBridge: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => native);
vi.mock('@tauri-apps/plugin-os', () => ({ platform: native.platform }));
vi.mock('./electron', () => ({ electronBridge: native.electronBridge }));

import {
  openExternalAuthUrl,
  openExternalAuthWindow,
  isDesktopAuthClient,
  openSystemAuthUrl,
  startInAppAuthSession,
} from './external-auth';

beforeEach(() => {
  vi.clearAllMocks();
  native.isTauri.mockReturnValue(true);
  native.platform.mockReturnValue('ios');
  native.invoke.mockResolvedValue(undefined);
  native.electronBridge.mockReturnValue(undefined);
});

describe('authentication browsers', () => {
  test.each(['ios', 'android'])('does not offer the system browser on %s', async (platform) => {
    native.platform.mockReturnValue(platform);
    expect(isDesktopAuthClient()).toBe(false);
    await expect(openSystemAuthUrl('https://auth.example.org')).rejects.toThrow('desktop');
    expect(native.invoke).not.toHaveBeenCalled();
  });

  test('opens the Electron system browser through its bridge', async () => {
    native.isTauri.mockReturnValue(false);
    const openAuthInSystemBrowser = vi.fn().mockResolvedValue(undefined);
    native.electronBridge.mockReturnValue({ openAuthInSystemBrowser });
    await openSystemAuthUrl('https://auth.example.org/authorize');
    expect(openAuthInSystemBrowser).toHaveBeenCalledExactlyOnceWith(
      'https://auth.example.org/authorize'
    );
    expect(native.invoke).not.toHaveBeenCalled();
  });

  test.each(['file:///etc/passwd', 'javascript:alert(1)'])(
    'rejects system auth URL %s',
    async (url) => {
      native.isTauri.mockReturnValue(false);
      const openAuthInSystemBrowser = vi.fn();
      native.electronBridge.mockReturnValue({ openAuthInSystemBrowser });
      await expect(openSystemAuthUrl(url)).rejects.toThrow('HTTP');
      expect(openAuthInSystemBrowser).not.toHaveBeenCalled();
    }
  );

  test.each(['ios', 'android'])('keeps authentication pages inside %s', async (platform) => {
    native.platform.mockReturnValue(platform);
    await openExternalAuthUrl('https://matrix.example.org/register');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('open_in_app_auth_url', {
      id: expect.stringMatching(/^sable-auth-/) as unknown,
      url: 'https://matrix.example.org/register',
      callbackUri: undefined,
      sheet: false,
    });
  });

  test('reports when Android opened the page as a sheet beside the app', async () => {
    native.platform.mockReturnValue('android');
    native.invoke.mockResolvedValueOnce(true);
    const browser = openExternalAuthWindow('approval', { sheet: true });
    if (!browser) throw new Error('Browser was not created');
    await expect(browser.navigate('https://auth.example.org/device')).resolves.toBe(true);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('open_in_app_auth_url', {
      id: 'approval',
      url: 'https://auth.example.org/device',
      callbackUri: undefined,
      sheet: true,
    });
  });

  test('reserves a web popup synchronously and closes it after cross-origin navigation', async () => {
    native.isTauri.mockReturnValue(false);
    const popup = { location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => popup);
    vi.stubGlobal('window', { open });
    try {
      const browser = openExternalAuthWindow('approval');
      expect(open).toHaveBeenCalledExactlyOnceWith(
        'about:blank',
        'approval',
        'popup,width=520,height=720'
      );
      await browser?.navigate('https://auth.example.org/device');
      expect(popup.location.replace).toHaveBeenCalledWith('https://auth.example.org/device');
      await browser?.close();
      expect(popup.close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('reports blocked popups', async () => {
    native.isTauri.mockReturnValue(false);
    vi.stubGlobal('window', { open: () => null });
    try {
      expect(openExternalAuthWindow('approval')).toBeNull();
      await expect(openExternalAuthUrl('https://auth.example.org/device')).rejects.toThrow(
        'blocked'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each(['ios', 'android'])(
    'closes the matching %s browser once, even when completion arrives during opening',
    async (platform) => {
      native.platform.mockReturnValue(platform);
      let opened!: () => void;
      native.invoke.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          opened = resolve;
        })
      );
      const browser = openExternalAuthWindow('approval');
      if (!browser) throw new Error('Browser was not created');
      const navigating = browser.navigate('https://auth.example.org/device');
      await vi.waitFor(() => {
        expect(native.invoke).toHaveBeenCalledOnce();
      });
      const closing = browser.close();
      void browser.close();
      expect(native.invoke).toHaveBeenCalledOnce();
      opened();
      await navigating;
      await closing;
      expect(native.invoke).toHaveBeenCalledTimes(2);
      expect(native.invoke).toHaveBeenLastCalledWith('close_in_app_auth_window', {
        id: 'approval',
      });
    }
  );

  test('opens and closes Electron popups through the isolated bridge', async () => {
    native.isTauri.mockReturnValue(false);
    const bridge = {
      openAuthWindow: vi.fn().mockResolvedValue(undefined),
      closeAuthWindow: vi.fn().mockResolvedValue(undefined),
    };
    native.electronBridge.mockReturnValue(bridge);
    const browser = openExternalAuthWindow('approval');
    if (!browser) throw new Error('Browser was not created');
    await browser.navigate('https://auth.example.org/device');
    expect(bridge.openAuthWindow).toHaveBeenCalledWith(
      'approval',
      'https://auth.example.org/device'
    );
    await browser.close();
    expect(bridge.closeAuthWindow).toHaveBeenCalledWith('approval');
    expect(native.invoke).not.toHaveBeenCalled();
  });

  test('returns the iOS authentication callback', async () => {
    const callback = 'moe.sable.next:/oidc?code=example';
    native.invoke.mockResolvedValue(callback);
    await expect(startInAppAuthSession('https://auth.example.org', callback)).resolves.toBe(
      callback
    );
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('plugin:auth-session|start', {
      authUrl: 'https://auth.example.org',
      callbackUrlScheme: 'moe.sable.next',
      ephemeral: false,
    });
  });

  test('closes Electron approval while the remote page is still loading', async () => {
    native.isTauri.mockReturnValue(false);
    const bridge = {
      openAuthWindow: vi.fn(() => new Promise<void>(() => {})),
      closeAuthWindow: vi.fn().mockResolvedValue(undefined),
    };
    native.electronBridge.mockReturnValue(bridge);
    const browser = openExternalAuthWindow('approval');
    if (!browser) throw new Error('Browser was not created');
    void browser.navigate('https://auth.example.org/device');
    await browser.close();
    expect(bridge.closeAuthWindow).toHaveBeenCalledExactlyOnceWith('approval');
  });

  test('does not replace a cancelled iOS session with an external browser', async () => {
    native.invoke.mockRejectedValue('user_cancelled');
    await expect(
      startInAppAuthSession('https://auth.example.org', 'moe.sable.next:/oidc')
    ).rejects.toBe('user_cancelled');
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  test('leaves other platforms to their existing authentication flow', async () => {
    native.platform.mockReturnValue('android');
    await expect(
      startInAppAuthSession('https://auth.example.org', 'moe.sable.next:/oidc')
    ).resolves.toBeNull();
    native.isTauri.mockReturnValue(false);
    await expect(
      startInAppAuthSession('https://auth.example.org', 'https://app.example.org/oidc')
    ).resolves.toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
