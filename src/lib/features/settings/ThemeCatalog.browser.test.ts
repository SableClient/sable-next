import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { clearThemePreview, replaceCustomThemes } from '#lib/settings/custom-themes.svelte.js';

import CustomThemes from './CustomThemes.svelte';
import { CATALOG_URL, resetCatalog } from './theme-catalog';

const FILES = 'https://git.sable.moe/SableClient/themes/raw/branch/main/';
const NAMES = Array.from({ length: 60 }, (_, index) => `Theme ${String(index).padStart(2, '0')}`);

interface Stub {
  holdThemes: Promise<void> | null;
  catalogFailures: number;
}

let stub: Stub = { holdThemes: null, catalogFailures: 0 };

function respond(url: string): Promise<Response> {
  if (url === CATALOG_URL) {
    if (stub.catalogFailures > 0) {
      stub.catalogFailures -= 1;
      return Promise.resolve(new Response('', { status: 500 }));
    }
    return Promise.resolve(
      Response.json({
        themes: NAMES.map((name, index) => ({
          basename: name,
          previewUrl: null,
          fullUrl: `${FILES}themes/theme-${String(index)}.sable.css`,
        })),
        tweaks: Array.from({ length: 30 }, (_, index) => ({
          basename: `Tweak ${String(index).padStart(2, '0')}`,
          previewUrl: null,
          fullUrl: `${FILES}tweaks/tweak-${String(index)}.sable.css`,
        })),
      })
    );
  }
  if (url.includes('/tweaks/')) {
    const index = Number(/tweak-(\d+)/.exec(url)?.[1]);
    return Promise.resolve(
      new Response(
        `/*\n@sable-tweak\nname: Tweak ${String(index).padStart(2, '0')}\ndescription: Round corners\n*/\n.x { --radius: 8px; }`
      )
    );
  }
  const index = Number(/theme-(\d+)/.exec(url)?.[1]);
  const body = `/*\n@sable-theme\nname: ${NAMES[index] ?? ''}\nkind: ${index % 2 === 0 ? 'dark' : 'light'}\ncontrast: ${index % 3 === 0 ? 'high' : 'low'}\n*/\n.x { --sable-bg-container: #101018; }`;
  if (index >= 30 && stub.holdThemes) return stub.holdThemes.then(() => new Response(body));
  return Promise.resolve(new Response(body));
}

beforeEach(() => {
  resetCatalog();
  stub = { holdThemes: null, catalogFailures: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => respond(url))
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  replaceCustomThemes({
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  });
  clearThemePreview();
  await page.viewport(414, 800);
});

async function openCatalog(expected = NAMES.length) {
  await page.viewport(1280, 900);
  const screen = await render(CustomThemes);
  await userEvent.click(screen.getByRole('button', { name: 'Theme catalogue', exact: true }));
  const panel = () => {
    const node = document.querySelector<HTMLElement>('[role="tabpanel"]');
    if (!node) throw new Error('the catalogue panel is not rendered');
    return node;
  };
  const installs = () =>
    [...panel().querySelectorAll('button')].filter(
      (button) => button.textContent.trim() === 'Install'
    );
  await expect.poll(() => installs().length, { timeout: 15_000 }).toBe(expected);
  return { screen, panel, installs };
}

async function stableScroll(panel: HTMLElement, top: number): Promise<void> {
  const offsets: number[] = [];
  const until = performance.now() + 800;
  while (performance.now() < until) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    offsets.push(panel.scrollTop);
  }
  expect(Math.min(...offsets)).toBe(top);
  expect(Math.max(...offsets)).toBe(top);
}

test('the theme catalogue keeps its scroll position while idle and on hover', async () => {
  const { panel } = await openCatalog();
  panel().scrollTop = 1000;
  const top = panel().scrollTop;
  expect(top).toBeGreaterThan(0);
  await stableScroll(panel(), top);

  for (const fraction of [0.25, 0.75]) {
    const bounds = panel().getBoundingClientRect();
    await userEvent.hover(panel(), {
      position: { x: bounds.width / 2, y: bounds.height * fraction },
    });
    await stableScroll(panel(), top);
  }
});

test('scrolling with the mouse wheel leaves the catalogue at the chosen position', async () => {
  const { panel } = await openCatalog();
  await userEvent.hover(panel());
  const scrollBy = async (delta: number): Promise<number> => {
    await userEvent.wheel(panel(), { delta: { x: 0, y: delta } });
    let last = -1;
    let steady = 0;
    while (steady < 3) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = panel().scrollTop;
      steady = next === last ? steady + 1 : 0;
      last = next;
    }
    return last;
  };
  const down = await scrollBy(1000);
  expect(down).toBeGreaterThan(0);
  await stableScroll(panel(), down);
  const up = await scrollBy(-200);
  expect(up).toBeLessThan(down);
  await stableScroll(panel(), up);
});

test('the catalogue can be browsed while more entries load', async () => {
  let release: () => void = () => {};
  stub.holdThemes = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const { panel, installs } = await openCatalog(30);
    await expect
      .poll(() => document.querySelector('.catalog')?.getAttribute('aria-busy'))
      .toBe('true');
    panel().scrollTop = 1000;
    await stableScroll(panel(), 1000);
    release();
    await expect.poll(() => installs().length, { timeout: 15_000 }).toBe(60);
    await expect
      .poll(() => document.querySelector('.catalog')?.getAttribute('aria-busy'))
      .toBe('false');
    await stableScroll(panel(), 1000);
  } finally {
    release();
  }
});

test('a failed catalogue load can be retried', async () => {
  stub.catalogFailures = 1;
  await page.viewport(1280, 900);
  const screen = await render(CustomThemes);
  await userEvent.click(screen.getByRole('button', { name: 'Theme catalogue', exact: true }));
  await expect.element(screen.getByText(/Could not load the official theme catalog/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Try again', exact: true }));
  const panel = document.querySelector<HTMLElement>('[role="tabpanel"]');
  await expect
    .poll(
      () =>
        [...(document.querySelector('[role="tabpanel"]')?.querySelectorAll('button') ?? [])].filter(
          (button) => button.textContent.trim() === 'Install'
        ).length,
      { timeout: 15_000 }
    )
    .toBe(60);
  const scroller = panel ?? document.querySelector<HTMLElement>('[role="tabpanel"]');
  if (!scroller) throw new Error('the catalogue panel is not rendered');
  scroller.scrollTop = 1000;
  await stableScroll(scroller, 1000);
});

test('a theme further down the catalogue can be previewed and installed', async () => {
  const { screen, panel } = await openCatalog();
  const tile = screen.getByRole('button', { name: /^Theme 30\b/ });
  const card = () => tile.element().closest<HTMLElement>('.tile');
  await userEvent.click(tile);
  await expect.element(screen.getByRole('button', { name: 'Revert', exact: true })).toBeVisible();
  await expect.element(tile).toBeInViewport();
  const install = () =>
    [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Install');
  install()?.scrollIntoView({ block: 'nearest' });
  const top = panel().scrollTop;
  expect(top).toBeGreaterThan(0);
  await stableScroll(panel(), top);

  const installButton = install();
  if (!installButton) throw new Error('the install button is missing');
  await userEvent.click(installButton);
  await expect.poll(() => card()?.textContent).toContain('Installed');
  await expect.element(tile).toBeInViewport();
  await stableScroll(panel(), top);
});

test('filters and keyboard tab navigation work after scrolling', async () => {
  const { screen, panel, installs } = await openCatalog();
  panel().scrollTop = 2000;
  const dialog = screen.getByRole('dialog', { name: 'Theme catalogue', exact: true });
  await userEvent.click(dialog.getByRole('button', { name: 'Light mode', exact: true }));
  await expect.poll(() => installs().length).toBe(30);
  await userEvent.click(dialog.getByRole('button', { name: 'High contrast', exact: true }));
  await expect.poll(() => installs().length).toBe(10);
  const search = dialog.getByRole('searchbox', { name: 'Search themes and tweaks' });
  await userEvent.fill(search.element(), 'Theme 03');
  await expect.poll(() => installs().length).toBe(1);
  await expect.element(screen.getByRole('button', { name: /^Theme 03\b/ })).toBeInViewport();
  await userEvent.fill(search.element(), 'no matching theme');
  await expect.element(screen.getByText('Nothing matches.', { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters', exact: true }));
  await expect.poll(() => installs().length).toBe(60);

  const themes = dialog.getByRole('tab', { name: /^Themes/ });
  const tweaks = dialog.getByRole('tab', { name: /^Tweaks/ });
  themes.element().focus();
  await userEvent.keyboard('{ArrowRight}');
  await expect.element(tweaks).toHaveFocus();
  await expect.poll(() => installs().length).toBe(30);
  panel().scrollTop = 500;
  await stableScroll(panel(), panel().scrollTop);
  const row = () =>
    [...panel().querySelectorAll('li')].find((item) => item.textContent.includes('Tweak 20'));
  const tweakInstall = [...(row()?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent.trim() === 'Install'
  );
  if (!tweakInstall) throw new Error('the tweak install button is missing');
  await userEvent.click(tweakInstall);
  await expect.poll(() => row()?.textContent).toContain('Installed');
  tweaks.element().focus();
  await userEvent.keyboard('{Home}');
  await expect.element(themes).toHaveFocus();
  await expect.poll(() => installs().length).toBe(60);
});

test('preview can be reverted, kept, and cleared when the catalogue reopens', async () => {
  const { screen, panel, installs } = await openCatalog();
  const theme = () => screen.getByRole('button', { name: /^Theme 30\b/ });
  const revert = () => screen.getByRole('button', { name: 'Revert', exact: true });
  await userEvent.click(theme());
  await expect.element(revert()).toBeVisible();
  await userEvent.click(revert());
  await expect.poll(() => revert().elements().length).toBe(0);
  await expect.element(theme()).toBeInViewport();
  await userEvent.click(theme());
  await userEvent.click(screen.getByRole('button', { name: 'Use for dark mode', exact: true }));
  const card = () => theme().element().closest<HTMLElement>('.tile');
  await expect.poll(() => card()?.textContent).toContain('In use for dark mode');
  await userEvent.click(screen.getByRole('button', { name: /^Theme 31\b/ }));
  await expect.element(revert()).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Close catalogue', exact: true }));
  await userEvent.click(screen.getByRole('button', { name: 'Theme catalogue', exact: true }));
  await expect.poll(() => revert().elements().length).toBe(0);
  await expect.poll(() => installs().length).toBe(59);
  expect(panel().textContent).toContain('In use for dark mode');
});
