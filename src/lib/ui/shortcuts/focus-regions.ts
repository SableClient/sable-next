import { isRendered } from '#lib/ui/roving-focus.js';

const TABBABLE =
  '[tabindex="0"], [contenteditable="true"], a[href], button, input, textarea, select, [role="treeitem"]';

export const FOCUS_REGIONS = ['spaces', 'rooms', 'timeline', 'composer', 'panel'] as const;

export type FocusRegionId = (typeof FOCUS_REGIONS)[number];

const isUsable = (element: HTMLElement) =>
  (element.tabIndex >= 0 || element.isContentEditable) &&
  !element.matches(':disabled, [role="separator"]') &&
  isRendered(element);

function containers(region: FocusRegionId, root: ParentNode): HTMLElement[] {
  if (region === 'timeline') {
    return [...root.querySelectorAll<HTMLElement>('[role="log"], [role="feed"]')].filter(
      (element) => !element.closest('aside')
    );
  }
  return [...root.querySelectorAll<HTMLElement>(`[data-focus-region="${region}"]`)];
}

function tabStop(container: HTMLElement): HTMLElement | null {
  const candidates = [container, ...container.querySelectorAll<HTMLElement>(TABBABLE)];
  return candidates.find(isUsable) ?? null;
}

function regionTarget(region: FocusRegionId, root: ParentNode): HTMLElement | null {
  for (const container of containers(region, root)) {
    const target = tabStop(container);
    if (target) return target;
  }
  return null;
}

export function focusRegion(region: FocusRegionId, root: ParentNode = document): boolean {
  const target = regionTarget(region, root);
  target?.focus();
  return target !== null;
}

function activeRegionIndex(regions: readonly FocusRegionId[], root: ParentNode): number {
  const active = document.activeElement;
  if (!active) return -1;
  return regions.findIndex((region) =>
    containers(region, root).some((container) => container.contains(active))
  );
}

export function cycleRegion(direction: 1 | -1, root: ParentNode = document): boolean {
  const available = FOCUS_REGIONS.filter((region) => regionTarget(region, root) !== null);
  if (available.length === 0) return false;
  const current = activeRegionIndex(available, root);
  const at =
    current < 0
      ? direction === 1
        ? 0
        : available.length - 1
      : (current + direction + available.length) % available.length;
  return focusRegion(available[at], root);
}
