import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
import GlobeSimpleIcon from 'phosphor-svelte/lib/GlobeSimpleIcon';
import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';
import ListNumbersIcon from 'phosphor-svelte/lib/ListNumbersIcon';
import type { SettingsCategory } from '../registry';

export const personasCategory: SettingsCategory = {
  id: 'personas',
  name: 'personas.title',
  icon: UserSwitchIcon,
  sections: [
    { id: 'persona-sending', name: 'settings.groups.sending' },
    { id: 'persona-picker-options', name: 'settings.groups.personaPicker' },
    { id: 'persona-trigger', name: 'settings.groups.personaTrigger' },
  ],
  items: [
    {
      key: 'personaSelectionScope',
      section: 'persona-sending',
      icon: GlobeSimpleIcon,
      name: 'personas.selectionScope',
      type: 'select',
      options: [
        { value: 'account', label: 'personas.selectionScopeAccount' },
        { value: 'space', label: 'personas.selectionScopeSpace' },
        { value: 'room', label: 'personas.selectionScopeRoom' },
        { value: 'picker', label: 'personas.selectionScopePicker' },
      ],
    },
    {
      key: 'personaPicker',
      section: 'persona-picker-options',
      icon: UserSwitchIcon,
      name: 'personas.picker',
      type: 'boolean',
    },
    {
      key: 'personaPickerSortOrder',
      section: 'persona-picker-options',
      icon: ListNumbersIcon,
      name: 'personas.pickerSortOrder',
      type: 'select',
      options: [
        { value: 'manual', label: 'common.sortManual' },
        { value: 'alphabetical-asc', label: 'common.sortNameAsc' },
        { value: 'alphabetical-desc', label: 'common.sortNameDesc' },
        { value: 'recent', label: 'personas.sortNameRecentlyUsed' },
      ],
      gatedBy: 'personaPicker',
    },
    {
      key: 'personaPickerLeftSide',
      section: 'persona-picker-options',
      icon: PushPinIcon,
      name: 'personas.pickerLeftSide',
      type: 'boolean',
      gatedBy: 'personaPicker',
    },
    {
      key: 'personaPickerShowAccountWhenDeselected',
      section: 'persona-picker-options',
      icon: UserSwitchIcon,
      name: 'personas.pickerShowAccountWhenDeselected',
      type: 'boolean',
      gatedBy: 'personaPicker',
    },
    {
      key: 'personaProxying',
      section: 'persona-trigger',
      icon: ChatTextIcon,
      name: 'personas.proxying',
      description: 'personas.proxyingHint',
      type: 'boolean',
    },
    {
      key: 'personaKeepAfterShorthand',
      section: 'persona-trigger',
      icon: PushPinIcon,
      name: 'personas.latching',
      type: 'boolean',
      gatedBy: 'personaProxying',
    },
    {
      key: 'personaFallback',
      section: 'persona-sending',
      icon: TextAaIcon,
      name: 'personas.fallback',
      type: 'boolean',
    },
  ],
};
