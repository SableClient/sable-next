import { afterEach, describe, expect, it } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { findEmbed } from './providers';
import YoutubeEmbed from './YoutubeEmbed.svelte';

const VIDEO = 'https://youtu.be/MTn_bhTVr2U';

afterEach(() => {
  preferences.clientEmbeds = false;
  preferences.encryptedClientEmbeds = false;
  preferences.youtubeEmbeds = false;
});

describe('findEmbed', () => {
  it('embeds nothing until client embeds are on', () => {
    preferences.youtubeEmbeds = true;
    expect(findEmbed(VIDEO, false)).toBeNull();
  });

  it('embeds nothing for a provider that is switched off', () => {
    preferences.clientEmbeds = true;
    expect(findEmbed(VIDEO, false)).toBeNull();
  });

  it('embeds a matching link in an unencrypted room', () => {
    preferences.clientEmbeds = true;
    preferences.youtubeEmbeds = true;
    expect(findEmbed(VIDEO, false)).toBe(YoutubeEmbed);
    expect(findEmbed('https://example.org/', false)).toBeNull();
  });

  it.each([true, null])('needs its own consent when encrypted is %s', (encrypted) => {
    preferences.clientEmbeds = true;
    preferences.youtubeEmbeds = true;
    expect(findEmbed(VIDEO, encrypted)).toBeNull();
    preferences.encryptedClientEmbeds = true;
    expect(findEmbed(VIDEO, encrypted)).toBe(YoutubeEmbed);
  });
});
