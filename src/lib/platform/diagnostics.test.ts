import { describe, expect, it } from 'vitest';

import { issuePlatformOption, webPlatformLabel } from './diagnostics.js';

const MAC_FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

describe('webPlatformLabel', () => {
  it('omits the architecture when there are no client hints', () => {
    expect(webPlatformLabel(MAC_FIREFOX, undefined)).toBe('macOS');
  });

  it('reports the architecture when client hints provide one', () => {
    expect(webPlatformLabel(MAC_FIREFOX, 'arm 64-bit')).toBe('macOS (arm 64-bit)');
  });

  it('matches Android before Linux', () => {
    expect(webPlatformLabel(ANDROID_CHROME, undefined)).toBe('Android');
  });

  it('falls back on an unrecognised user agent', () => {
    expect(webPlatformLabel('Mozilla/5.0 (Unknown)', undefined)).toBe('unknown');
  });
});

describe('issuePlatformOption', () => {
  it('names the web build Web', () => {
    expect(issuePlatformOption(undefined)).toBe('Web');
  });

  it('maps native platforms onto the issue template options', () => {
    expect(issuePlatformOption('linux')).toBe('Linux');
    expect(issuePlatformOption('macos')).toBe('macOS');
    expect(issuePlatformOption('ios')).toBe('iOS');
  });

  it('leaves an unknown native platform unset', () => {
    expect(issuePlatformOption('freebsd')).toBe('');
  });
});
