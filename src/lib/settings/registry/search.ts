import DatabaseIcon from 'phosphor-svelte/lib/DatabaseIcon';
import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
import { currentLocale } from '#lib/i18n.js';
import { isNativeMobile } from '#lib/platform/os.js';
import {
  SEARCH_BASE_EVENTS,
  SEARCH_BATCH_SIZES,
  SEARCH_CRAWL_PAUSES,
  SEARCH_FLUSH_INTERVALS,
  SEARCH_INDEX_LIMITS,
  SEARCH_MAX_EVENTS,
  SEARCH_TRICKLE_PAUSES,
} from '../definitions';
import type { SettingsCategory } from '../registry';

export const searchCategory: SettingsCategory = {
  id: 'search',
  name: 'settings.searchTitle',
  icon: MagnifyingGlassIcon,
  sections: [
    { id: 'message-search', name: 'settings.groups.messageSearch' },
    { id: 'developer-search-metrics', name: 'settings.developerSearchTitle' },
  ],
  items: [
    {
      key: 'showSearch',
      section: 'message-search',
      icon: MagnifyingGlassIcon,
      name: 'settings.showSearch',
      type: 'boolean',
    },
    {
      key: 'searchCrawler',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchCrawler',
      description: 'settings.searchCrawlerHint',
      type: 'boolean',
    },
    {
      key: 'searchUnmeteredOnly',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchUnmeteredOnly',
      description: 'settings.searchUnmeteredOnlyHint',
      type: 'boolean',
      supported: isNativeMobile,
    },
    {
      key: 'searchSharing',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchSharing',
      description: 'settings.searchSharingHint',
      type: 'boolean',
    },
    {
      key: 'serverSearch',
      section: 'message-search',
      icon: MagnifyingGlassIcon,
      name: 'settings.serverSearch',
      description: 'settings.serverSearchHint',
      type: 'boolean',
    },
    {
      key: 'searchIndexLimit',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchIndexLimit',
      type: 'select',
      options: SEARCH_INDEX_LIMITS.map((limit) => ({
        value: limit,
        label: Number(limit) >= 1024 ? `${String(Number(limit) / 1024)} GiB` : `${limit} MiB`,
        literal: true,
      })),
    },
    {
      key: 'searchCrawlPause',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchCrawlPause',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_CRAWL_PAUSES.map((value) => ({
        value,
        label: `${value} s`,
        literal: true,
      })),
    },
    {
      key: 'searchTricklePause',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchTricklePause',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_TRICKLE_PAUSES.map((value) => ({
        value,
        label: `${value} s`,
        literal: true,
      })),
    },
    {
      key: 'searchFlushInterval',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchFlushInterval',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_FLUSH_INTERVALS.map((value) => ({
        value,
        label: `${value} s`,
        literal: true,
      })),
    },
    {
      key: 'searchBatchSize',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchBatchSize',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_BATCH_SIZES.map((value) => ({
        value,
        get label() {
          return `${Number(value).toLocaleString(currentLocale())} events`;
        },
        literal: true,
      })),
    },
    {
      key: 'searchBaseEvents',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchBaseEvents',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_BASE_EVENTS.map((value) => ({
        value,
        get label() {
          return `${Number(value).toLocaleString(currentLocale())} events`;
        },
        literal: true,
      })),
    },
    {
      key: 'searchMaxEvents',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchMaxEvents',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_MAX_EVENTS.map((value) => ({
        value,
        get label() {
          return `${Number(value).toLocaleString(currentLocale())} events`;
        },
        literal: true,
      })),
    },
  ],
};
