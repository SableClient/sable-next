// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { settingsCategories, settingsPanels } from '#lib/settings/registry.js';
import { panelComponents, panelsFor } from './category-panels.js';

const panels = Object.values(settingsPanels).flat();

describe('settings panels', () => {
  it('register a component only for a declared panel', () => {
    const declared = new Set(panels.map((panel) => panel.id));
    for (const id of Object.keys(panelComponents)) expect(declared, id).toContain(id);
  });

  it('render every gated panel through the registry so the gate applies everywhere', () => {
    for (const panel of panels.filter((entry) => entry.supported)) {
      expect(panelComponents, panel.id).toHaveProperty([panel.id]);
    }
  });

  it('point panel rows at a panel of their own category', () => {
    for (const category of settingsCategories) {
      const ids = (settingsPanels[category.id] ?? []).map((panel) => panel.id);
      for (const item of category.items.filter((entry) => entry.panel !== undefined)) {
        expect(ids, `${category.id}: ${item.key}`).toContain(item.panel);
      }
    }
  });

  it('hide a panel and its search targets together', () => {
    const hidden = { oauth: false };
    const shown = { oauth: true };
    expect(panelsFor('account', hidden).map((panel) => panel.id)).not.toContain('link-device');
    expect(panelsFor('account', shown).map((panel) => panel.id)).toContain('link-device');

    const account = settingsCategories.find((category) => category.id === 'account');
    const link = account?.targets?.find((target) => target.focusId === 'link-device');
    expect(link?.supported?.(hidden)).toBe(false);
    expect(link?.supported?.(shown)).toBe(true);
  });
});
