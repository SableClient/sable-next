import { beforeEach, expect, test, vi } from 'vitest';
import type { Session } from 'electron';

const { showMessageBox, askForMediaAccess, readGrantsFile, writeGrantsFile } = vi.hoisted(() => ({
  showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })),
  askForMediaAccess: vi.fn(() => Promise.resolve(true)),
  readGrantsFile: vi.fn(() => '[]'),
  writeGrantsFile: vi.fn(() => Promise.resolve()),
}));
vi.mock('electron', () => ({
  dialog: { showMessageBox },
  systemPreferences: { askForMediaAccess },
}));
vi.mock('node:fs', () => ({ readFileSync: readGrantsFile }));
vi.mock('./persistence', () => ({ writeJson: writeGrantsFile }));

import { enforcePermissions } from './permissions';

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;

function handlers() {
  let request!: RequestHandler;
  let check!: CheckHandler;
  const session = {
    setPermissionRequestHandler: (handler: RequestHandler) => (request = handler),
    setPermissionCheckHandler: (handler: CheckHandler) => (check = handler),
  } as unknown as Session;
  enforcePermissions(
    session,
    '/unused/grants.json',
    (url) => {
      const parsed = URL.parse(url ?? '');
      return parsed?.protocol === 'sable-app:' && parsed.host === 'app';
    },
    () => null
  );
  return { request, check };
}

function contents(url = 'sable-app://app/') {
  return { getURL: () => url, isDestroyed: () => false } as Parameters<RequestHandler>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  showMessageBox.mockResolvedValue({ response: 1 });
  readGrantsFile.mockReturnValue('[]');
  writeGrantsFile.mockResolvedValue(undefined);
});

test.skipIf(process.platform === 'darwin')(
  'an app permission is granted only after its file is saved',
  async () => {
    let saved!: () => void;
    const saving = new Promise<void>((resolve) => {
      saved = resolve;
    });
    showMessageBox.mockResolvedValue({ response: 0 });
    writeGrantsFile.mockReturnValueOnce(saving);
    const callback = vi.fn();
    handlers().request(contents(), 'geolocation', callback, {
      isMainFrame: true,
      requestingUrl: 'sable-app://app/',
    });
    await vi.waitFor(() => {
      expect(writeGrantsFile).toHaveBeenCalledWith('/unused/grants.json', ['location']);
    });
    expect(callback).not.toHaveBeenCalled();
    saved();
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith(true);
    });
  }
);

test.skipIf(process.platform === 'darwin')(
  'a failed permission save denies the request',
  async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    writeGrantsFile.mockRejectedValueOnce(new Error('disk full'));
    const callback = vi.fn();
    handlers().request(contents(), 'geolocation', callback, {
      isMainFrame: true,
      requestingUrl: 'sable-app://app/',
    });
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith(false);
    });
  }
);

test('allows Electron 44 display capture to reach the source picker', () => {
  const callback = vi.fn();
  handlers().request(contents(), 'media', callback, {
    isMainFrame: true,
    requestingUrl: 'sable-app://app/',
    mediaTypes: [],
  });
  expect(callback).toHaveBeenCalledWith(true);
  expect(showMessageBox).not.toHaveBeenCalled();
});

test('does not allow an empty media request from an external page', () => {
  const callback = vi.fn();
  handlers().request(contents('https://example.org/'), 'media', callback, {
    isMainFrame: true,
    requestingUrl: 'https://example.org/',
    mediaTypes: [],
  });
  expect(callback).toHaveBeenCalledWith(false);
});

test('a media request with missing details is still denied', () => {
  const callback = vi.fn();
  handlers().request(contents(), 'media', callback, {
    isMainFrame: true,
    requestingUrl: 'sable-app://app/',
  });
  expect(callback).toHaveBeenCalledWith(false);
});

test.each(['audio', 'video'] as const)(
  'keeps %s device permissions on their existing path',
  async (type) => {
    const callback = vi.fn();
    handlers().request(contents(), 'media', callback, {
      isMainFrame: true,
      requestingUrl: 'sable-app://app/',
      mediaTypes: [type],
    });
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledWith(process.platform === 'darwin');
    });
    expect(showMessageBox).toHaveBeenCalledTimes(process.platform === 'darwin' ? 0 : 1);
    if (process.platform === 'darwin') {
      expect(askForMediaAccess).toHaveBeenCalledWith(type === 'audio' ? 'microphone' : 'camera');
    }
  }
);

test('allows the explicit display-capture permission used by newer Electron versions', () => {
  const callback = vi.fn();
  handlers().request(contents(), 'display-capture', callback, {
    isMainFrame: true,
    requestingUrl: 'sable-app://app/',
  });
  expect(callback).toHaveBeenCalledWith(true);
});

test.each(['media', 'notifications', 'display-capture', 'geolocation'] as const)(
  'an embedded site cannot inherit the app %s permission',
  (permission) => {
    const { check } = handlers();
    expect(
      check(contents(), permission, 'https://widget.example', {
        embeddingOrigin: 'sable-app://app',
        requestingUrl: 'https://widget.example/call',
        securityOrigin: 'https://widget.example',
        isMainFrame: false,
        mediaType: 'audio',
      })
    ).toBe(false);
  }
);

test('an embedded site prompts even when the app already has device access', async () => {
  readGrantsFile.mockReturnValue('["microphone", "camera", "location"]');
  const callback = vi.fn();
  handlers().request(contents(), 'media', callback, {
    requestingUrl: 'https://widget.example/call',
    securityOrigin: 'https://widget.example',
    isMainFrame: false,
    mediaTypes: ['audio'],
  });
  await vi.waitFor(() => {
    expect(callback).toHaveBeenCalledWith(false);
  });
  expect(showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'https://widget.example wants to access your microphone.',
    })
  );
  expect(writeGrantsFile).not.toHaveBeenCalled();
});

test('an embedded grant belongs to its origin and device for this session', async () => {
  showMessageBox.mockResolvedValue({ response: 0 });
  const { request, check } = handlers();
  const callback = vi.fn();
  request(contents(), 'media', callback, {
    requestingUrl: 'https://widget.example/call',
    isMainFrame: false,
    mediaTypes: ['audio'],
  });
  await vi.waitFor(() => {
    expect(callback).toHaveBeenCalledWith(true);
  });
  const details = {
    embeddingOrigin: 'sable-app://app',
    isMainFrame: false,
    mediaType: 'audio' as const,
  };
  expect(check(contents(), 'media', 'https://widget.example', details)).toBe(true);
  expect(check(contents(), 'media', 'https://other.example', details)).toBe(false);
  expect(check(contents(), 'media', 'http://widget.example', details)).toBe(false);
  expect(check(contents(), 'media', 'https://widget.example:8443', details)).toBe(false);
  expect(
    check(contents(), 'media', 'https://widget.example', { ...details, mediaType: 'video' })
  ).toBe(false);
  expect(handlers().check(contents(), 'media', 'https://widget.example', details)).toBe(false);
  expect(writeGrantsFile).not.toHaveBeenCalled();
});

test.each(['', 'null', 'about:blank', 'data:text/html,hello', 'file:///tmp/widget.html'])(
  'denies an embedded request from %j without prompting',
  (url) => {
    const callback = vi.fn();
    handlers().request(contents(), 'geolocation', callback, {
      requestingUrl: url,
      isMainFrame: false,
    });
    expect(callback).toHaveBeenCalledWith(false);
    expect(showMessageBox).not.toHaveBeenCalled();
  }
);

test('rejects media requests whose security origin disagrees with the frame URL', () => {
  const callback = vi.fn();
  const { request, check } = handlers();
  request(contents(), 'media', callback, {
    requestingUrl: 'sable-app://app/',
    securityOrigin: 'https://other.example',
    isMainFrame: true,
    mediaTypes: ['audio'],
  });
  expect(callback).toHaveBeenCalledWith(false);
  expect(
    check(contents(), 'media', 'sable-app://app', {
      requestingUrl: 'sable-app://app/',
      securityOrigin: 'https://other.example',
      isMainFrame: true,
      mediaType: 'audio',
    })
  ).toBe(false);
});

test('keeps app media checks and service-worker notifications available', () => {
  const { check } = handlers();
  expect(
    check(contents(), 'media', 'sable-app://app', {
      isMainFrame: true,
      mediaType: 'audio',
    })
  ).toBe(true);
  expect(check(null, 'notifications', 'sable-app://app', { isMainFrame: false })).toBe(true);
});

test.each(['navigation', 'closed window'])('ignores an approval after %s', async (change) => {
  showMessageBox.mockResolvedValue({ response: 0 });
  let changed = false;
  const page = {
    getURL: () =>
      changed && change === 'navigation' ? 'https://other.example/' : 'sable-app://app/',
    isDestroyed: () => changed && change === 'closed window',
  } as Parameters<RequestHandler>[0];
  const callback = vi.fn();
  handlers().request(page, 'media', callback, {
    requestingUrl: 'https://widget.example/call',
    isMainFrame: false,
    mediaTypes: ['audio'],
  });
  changed = true;
  await vi.waitFor(() => {
    expect(callback).toHaveBeenCalledWith(false);
  });
});
