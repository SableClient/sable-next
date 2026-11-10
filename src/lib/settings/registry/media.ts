import i18next from 'i18next';
import BrowserIcon from 'phosphor-svelte/lib/BrowserIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
import StickerIcon from 'phosphor-svelte/lib/StickerIcon';
import TargetIcon from 'phosphor-svelte/lib/TargetIcon';
import InstagramLogoIcon from 'phosphor-svelte/lib/InstagramLogoIcon';
import TiktokLogoIcon from 'phosphor-svelte/lib/TiktokLogoIcon';
import YoutubeLogoIcon from 'phosphor-svelte/lib/YoutubeLogoIcon';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { mediaPreviewSettings } from '../media-previews.svelte.js';
import { preferences } from '../preferences.svelte';
import type { MediaAutoLoad } from '../definitions';
import type { SettingsCategory } from '../registry';

export const mediaCategory: SettingsCategory = {
  id: 'media',
  name: 'settings.mediaTitle',
  icon: ImageIcon,
  sections: [
    { id: 'playback', name: 'settings.groups.playback' },
    { id: 'previews', name: 'settings.groups.previews' },
    { id: 'embeds', name: 'settings.groups.embeds' },
  ],
  items: [
    {
      key: 'mediaAutoLoad',
      section: 'playback',
      icon: ImageIcon,
      name: 'settings.mediaAutoLoad',
      type: 'select',
      options: [
        { value: 'on', label: 'settings.mediaAutoLoadAll' },
        { value: 'private', label: 'settings.mediaAutoLoadPrivate' },
        { value: 'off', label: 'common.never' },
      ],
      getValue: () => mediaPreviewSettings.mediaPreviews,
      setValue: (value) => {
        void mediaPreviewSettings.set({ media_previews: value as MediaAutoLoad }).catch(() => {
          toasts.error(i18next.t('errors.actionFailed'));
        });
      },
    },
    {
      key: 'autoplayGifs',
      section: 'playback',
      icon: FilmStripIcon,
      name: 'settings.autoplayGifs',
      terms: ['settings.terms.autoplayGifs'],
      type: 'boolean',
    },
    {
      key: 'autoplayStickers',
      section: 'playback',
      icon: StickerIcon,
      name: 'settings.autoplayStickers',
      type: 'boolean',
    },
    {
      key: 'pauseAnimationsWhenInactive',
      section: 'playback',
      icon: PauseIcon,
      name: 'settings.pauseAnimationsWhenInactive',
      type: 'boolean',
    },
    {
      key: 'urlPreviews',
      section: 'previews',
      icon: LinkSimpleIcon,
      name: 'settings.urlPreviews',
      terms: ['settings.terms.urlPreviews'],
      type: 'boolean',
    },
    {
      key: 'encryptedUrlPreviews',
      section: 'previews',
      icon: LinkSimpleIcon,
      name: 'settings.encryptedUrlPreviews',
      description: 'settings.encryptedUrlPreviewsHint',
      type: 'boolean',
    },
    {
      key: 'themeFileCards',
      section: 'previews',
      icon: PaletteIcon,
      name: 'settings.themeFileCards',
      type: 'boolean',
    },
    {
      key: 'clientEmbeds',
      section: 'embeds',
      icon: BrowserIcon,
      name: 'settings.clientEmbeds',
      description: 'settings.clientEmbedsHint',
      type: 'boolean',
    },
    {
      key: 'encryptedClientEmbeds',
      section: 'embeds',
      icon: BrowserIcon,
      name: 'settings.encryptedClientEmbeds',
      description: 'settings.encryptedClientEmbedsHint',
      type: 'boolean',
      gatedBy: 'clientEmbeds',
    },
    {
      key: 'youtubeEmbeds',
      section: 'embeds',
      icon: YoutubeLogoIcon,
      name: 'settings.youtubeEmbeds',
      type: 'boolean',
      gatedBy: 'clientEmbeds',
    },
    {
      key: 'useDearrow',
      section: 'embeds',
      icon: TargetIcon,
      name: 'settings.useDearrow',
      description: 'settings.useDearrowHint',
      type: 'boolean',
      gatedBy: 'youtubeEmbeds',
    },
    {
      key: 'dearrowThumbnailFallback',
      section: 'embeds',
      icon: ImageIcon,
      name: 'settings.dearrowThumbnailFallback',
      description: 'settings.dearrowThumbnailFallbackHint',
      type: 'select',
      gatedBy: 'useDearrow',
      options: [
        { value: 'random', label: 'settings.dearrowThumbnailRandom' },
        { value: 'original', label: 'settings.dearrowThumbnailOriginal' },
        { value: 'youtube_autogen', label: 'settings.dearrowThumbnailYoutubeAutogen' },
      ],
    },
    {
      key: 'youtubeThumbnailPosition',
      section: 'embeds',
      icon: ImageIcon,
      name: 'settings.youtubeThumbnailPosition',
      description: 'settings.youtubeThumbnailPositionHint',
      type: 'select',
      gatedBy: 'useDearrow',
      options: [
        { value: 'start', label: 'settings.youtubeThumbnailPositionStart' },
        { value: 'middle', label: 'settings.youtubeThumbnailPositionMiddle' },
        { value: 'end', label: 'settings.youtubeThumbnailPositionEnd' },
      ],
      supported: () => preferences.dearrowThumbnailFallback !== 'original',
    },
    {
      key: 'tiktokEmbeds',
      section: 'embeds',
      icon: TiktokLogoIcon,
      name: 'settings.tiktokEmbeds',
      type: 'boolean',
      gatedBy: 'clientEmbeds',
    },
    {
      key: 'instagramEmbeds',
      section: 'embeds',
      icon: InstagramLogoIcon,
      name: 'settings.instagramEmbeds',
      type: 'boolean',
      gatedBy: 'clientEmbeds',
    },
  ],
};
