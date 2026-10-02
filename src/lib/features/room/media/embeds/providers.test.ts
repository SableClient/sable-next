import { afterEach, describe, expect, it } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import InstagramEmbed from './InstagramEmbed.svelte';
import { findEmbed } from './providers';
import TiktokEmbed from './TiktokEmbed.svelte';
import YoutubeEmbed from './YoutubeEmbed.svelte';

const VIDEO = 'https://youtu.be/MTn_bhTVr2U';

afterEach(() => {
  preferences.clientEmbeds = false;
  preferences.encryptedClientEmbeds = false;
  preferences.youtubeEmbeds = false;
  preferences.tiktokEmbeds = false;
  preferences.instagramEmbeds = false;
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

  it('embeds a TikTok post only when its own switch is on', () => {
    const post = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
    preferences.clientEmbeds = true;
    expect(findEmbed(post, false)).toBeNull();
    preferences.tiktokEmbeds = true;
    expect(findEmbed(post, false)).toBe(TiktokEmbed);
  });

  it('embeds an Instagram post only when its own switch is on', () => {
    const post = 'https://www.instagram.com/p/CxYz_123-ab/';
    preferences.clientEmbeds = true;
    expect(findEmbed(post, false)).toBeNull();
    preferences.instagramEmbeds = true;
    expect(findEmbed(post, false)).toBe(InstagramEmbed);
  });
});
