import { readdirSync } from 'node:fs';
import { defineConfig } from 'i18next-cli';
import I18nextSveltePlugin from 'i18next-cli-plugin-svelte';

export default defineConfig({
  locales: readdirSync(new URL('./src/locales', import.meta.url))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length)),
  extract: {
    input: ['src/**/*.{svelte,ts,js,mjs}', 'electron/src/**/*.{ts,js}'],
    ignore: ['src/generated/**', '**/*.test.*'],
    output: 'src/locales/{{language}}.json',
    defaultNS: false,
    primaryLanguage: 'en',
    removeUnusedKeys: false,
    preservePatterns: [
      // Keys selected at runtime or read from registries.
      'calendar.people.*',
      'calendar.rsvp.*',
      'call.debugModes.*',
      'call.debugReasons.*',
      'call.debugTransports.*',
      'composer.schedule*',
      'composer.slash.*',
      'emoji.*',
      'presence.*',
      'room.joinRule.*',
      'room.historyVisibility.*',
      'room.moderationField.*',
      'room.moderationFlag.*',
      'room.moderationFlagHint.*',
      'room.moderationProtection.*',
      'room.moderationProtectionHint.*',
      'settings.*',
      'shortcuts.*',
      'sounds.*',
      'supporter.colors.*',
      'supporter.designs.*',
      'supporter.shapes.*',
      'timeline.cute.*',
      'timeline.memberGroup.*',
      'timeline.membership.*',
      'timeline.membershipBy.*',
      'timeline.utd.*',
    ],
  },
  plugins: [new I18nextSveltePlugin()],
});
