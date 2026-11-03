import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export type KnownViolation = { rule: string; html: RegExp; reason: string };

export async function violations(
  page: Page,
  { scope, known = [] }: { scope?: string; known?: KnownViolation[] } = {}
) {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  const result = await (scope ? builder.include(scope) : builder).analyze();
  return result.violations
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes
        .filter(
          (node) =>
            !known.some((entry) => entry.rule === violation.id && entry.html.test(node.html))
        )
        .map((node) => node.target.join(' ')),
    }))
    .filter((violation) => violation.nodes.length > 0);
}

/** Elements Tab reaches inside `region`, as short descriptions. */
export function tabStops(region: Locator): Promise<string[]> {
  return region.evaluate((root) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]'
      ),
    ]
      .filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          element.checkVisibility({ visibilityProperty: true })
      )
      .map(
        (element) =>
          `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') ?? element.textContent).trim().slice(0, 40)}"`
      )
  );
}

export async function tabTo(page: Page, target: Locator, limit = 30): Promise<void> {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Tab did not reach ${target.toString()} within ${String(limit)} presses`);
}
