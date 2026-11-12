import { describe, expect, it } from 'vitest';

import { localpartOf, serverNameOf } from './matrix-id';

describe('localpartOf', () => {
  it('drops the sigil and the server', () => {
    expect(localpartOf('@alice:example.org:8448')).toBe('alice');
  });

  it('keeps a bare name', () => {
    expect(localpartOf('alice')).toBe('alice');
  });
});

describe('serverNameOf', () => {
  it('keeps the port and IPv6 literals', () => {
    expect(serverNameOf('@alice:example.org:8448')).toBe('example.org:8448');
    expect(serverNameOf('#room:[::1]:8448')).toBe('[::1]:8448');
  });

  it('is empty without a server', () => {
    expect(serverNameOf('alice')).toBe('');
  });
});
