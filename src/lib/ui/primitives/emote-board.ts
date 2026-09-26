import type { Component } from 'svelte';
import BasketballIcon from 'phosphor-svelte/lib/BasketballIcon';
import CoffeeIcon from 'phosphor-svelte/lib/CoffeeIcon';
import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import LeafIcon from 'phosphor-svelte/lib/LeafIcon';
import LightbulbIcon from 'phosphor-svelte/lib/LightbulbIcon';
import PeaceIcon from 'phosphor-svelte/lib/PeaceIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';

import type { ImageUsageView } from '#src/generated/protocol';
import type { EmojiGroupId } from '#lib/emoji/emoji.js';

export type BoardTab = ImageUsageView | 'gif';

export const emojiGroupIcons: Record<EmojiGroupId, Component> = {
  people: SmileyIcon,
  nature: LeafIcon,
  food: CoffeeIcon,
  activity: BasketballIcon,
  travel: ImageIcon,
  object: LightbulbIcon,
  symbol: PeaceIcon,
  flag: FlagIcon,
};
