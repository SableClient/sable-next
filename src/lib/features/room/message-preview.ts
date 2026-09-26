const INTERACTIVE = 'a, button, input, select, textarea, summary, video, audio, [role="button"]';

export function opensFrom(event: MouseEvent): boolean {
  const target = event.target;
  if (target instanceof Element && target.closest(INTERACTIVE)) return false;
  return !(window.getSelection()?.toString() ?? '');
}
