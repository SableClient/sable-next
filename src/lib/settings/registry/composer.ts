import BellIcon from 'phosphor-svelte/lib/BellIcon';
import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import GifIcon from 'phosphor-svelte/lib/GifIcon';
import KeyReturnIcon from 'phosphor-svelte/lib/KeyReturnIcon';
import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
import LockIcon from 'phosphor-svelte/lib/LockIcon';
import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import StickerIcon from 'phosphor-svelte/lib/StickerIcon';
import SubtitlesIcon from 'phosphor-svelte/lib/SubtitlesIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import { preferences } from '../preferences.svelte';
import type { EnterKey } from '../definitions';
import type { SettingsCategory } from '../registry';

export function enterSettingLabels(mode: EnterKey): { name: string } {
  if (mode === 'newline') {
    return { name: 'settings.enterForNewline' };
  }
  if (mode === 'adaptive') {
    return { name: 'settings.enterForNewlineAdaptive' };
  }
  return { name: 'settings.enterSends' };
}

const enterSettingTerms = [
  'settings.enterSends',
  'settings.enterForNewline',
  'settings.enterKey',
  'settings.enterForNewlineAdaptive',
  'settings.enterForNewlineNewline',
  'settings.enterForNewlineSend',
] as const;

export const composerCategory: SettingsCategory = {
  id: 'composer',
  name: 'settings.composerTitle',
  icon: PencilSimpleIcon,
  sections: [
    { id: 'form', name: 'settings.groups.form' },
    { id: 'writing', name: 'settings.groups.writing' },
    { id: 'sending', name: 'settings.groups.sending' },
    { id: 'composer-buttons', name: 'settings.groups.buttons' },
  ],
  items: [
    {
      key: 'composerForm',
      section: 'form',
      icon: PencilSimpleIcon,
      name: 'settings.composerForm',
      description: 'settings.composerFormHint',
      type: 'select',
      options: [
        { value: 'short', label: 'settings.composerFormShort' },
        { value: 'adaptive', label: 'settings.composerFormAdaptive' },
        { value: 'tall', label: 'settings.composerFormTall' },
      ],
    },
    {
      key: 'alwaysInlineEditor',
      section: 'form',
      icon: PencilSimpleIcon,
      name: 'settings.alwaysInlineEditor',
      description: 'settings.alwaysInlineEditorHint',
      type: 'boolean',
      supported: () => preferences.composerForm !== 'tall',
    },
    {
      key: 'enterForNewline',
      section: 'writing',
      icon: KeyReturnIcon,
      get name() {
        return enterSettingLabels(preferences.enterForNewline).name;
      },
      terms: enterSettingTerms,
      type: 'select',
      options: [
        { value: 'adaptive', label: 'settings.enterForNewlineAdaptive' },
        { value: 'newline', label: 'settings.enterForNewlineNewline' },
        { value: 'send', label: 'settings.enterForNewlineSend' },
      ],
      panel: 'composer-enter',
    },
    {
      key: 'richTextComposer',
      section: 'writing',
      icon: CodeIcon,
      name: 'settings.richTextComposer',
      type: 'boolean',
    },
    {
      key: 'sedEdits',
      section: 'writing',
      icon: PencilSimpleIcon,
      name: 'settings.sedEdits',
      description: 'settings.sedEditsHint',
      type: 'boolean',
    },
    {
      key: 'inlineEditing',
      section: 'writing',
      icon: PencilSimpleIcon,
      name: 'settings.inlineEditing',
      description: 'settings.inlineEditingHint',
      type: 'boolean',
    },
    {
      key: 'composerSpellcheck',
      section: 'writing',
      icon: ChecksIcon,
      name: 'settings.composerSpellcheck',
      description: 'settings.composerSpellcheckHint',
      type: 'boolean',
    },
    {
      key: 'composerAutocapitalize',
      section: 'writing',
      icon: TextAaIcon,
      name: 'settings.composerAutocapitalize',
      description: 'settings.composerAutocapitalizeHint',
      type: 'boolean',
    },
    {
      key: 'emoticonToEmoji',
      section: 'writing',
      icon: SmileyIcon,
      name: 'settings.emoticonToEmoji',
      description: 'settings.emoticonToEmojiHint',
      type: 'boolean',
    },
    {
      key: 'formattingToolbar',
      section: 'writing',
      icon: TextAaIcon,
      name: 'settings.formattingToolbar',
      type: 'boolean',
    },
    {
      key: 'mentionInReplies',
      section: 'sending',
      icon: BellIcon,
      name: 'settings.mentionInReplies',
      type: 'boolean',
    },
    {
      key: 'scheduleInEncryptedRooms',
      section: 'sending',
      icon: LockIcon,
      name: 'settings.scheduleInEncryptedRooms',
      description: 'settings.scheduleInEncryptedRoomsHint',
      type: 'boolean',
    },
    {
      key: 'sendAttachmentAsCaption',
      section: 'sending',
      icon: SubtitlesIcon,
      name: 'settings.sendAttachmentAsCaption',
      type: 'boolean',
    },
    {
      key: 'sendAttachmentsAsGallery',
      section: 'sending',
      icon: SquaresFourIcon,
      name: 'settings.sendAttachmentsAsGallery',
      type: 'boolean',
    },
    {
      key: 'imageMetadata',
      section: 'sending',
      icon: MapPinIcon,
      name: 'settings.imageMetadata',
      description: 'settings.imageMetadataHint',
      type: 'select',
      options: [
        { value: 'location', label: 'settings.imageMetadataLocation' },
        { value: 'all', label: 'settings.imageMetadataAll' },
        { value: 'keep', label: 'settings.imageMetadataKeep' },
      ],
    },
    {
      key: 'composerFormatButton',
      section: 'composer-buttons',
      icon: TextAaIcon,
      name: 'settings.composerFormatButton',
      type: 'boolean',
      panel: 'composer-buttons',
    },
    {
      key: 'composerGifButton',
      section: 'composer-buttons',
      icon: GifIcon,
      name: 'settings.composerGifButton',
      type: 'boolean',
      panel: 'composer-buttons',
    },
    {
      key: 'composerStickerButton',
      section: 'composer-buttons',
      icon: StickerIcon,
      name: 'settings.composerStickerButton',
      type: 'boolean',
      panel: 'composer-buttons',
    },
    {
      key: 'composerEmoteButton',
      section: 'composer-buttons',
      icon: SmileyIcon,
      name: 'settings.composerEmoteButton',
      type: 'boolean',
      panel: 'composer-buttons',
    },
    {
      key: 'composerVoiceButton',
      section: 'composer-buttons',
      icon: MicrophoneIcon,
      name: 'settings.composerVoiceButton',
      type: 'boolean',
      panel: 'composer-buttons',
    },
  ],
};
