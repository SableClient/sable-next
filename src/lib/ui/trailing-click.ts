const EXPIRY_MS = 500;

let armed = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
let touchDown: EventTarget | null = null;
let clickHooked = false;

function swallow(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function disarm(): void {
  if (expiry) clearTimeout(expiry);
  expiry = undefined;
  if (!armed) return;
  armed = false;
  window.removeEventListener('pointerup', expire, true);
  window.removeEventListener('pointercancel', expire, true);
}

function expire(): void {
  if (expiry) return;
  expiry = setTimeout(disarm, EXPIRY_MS);
}

function hookClick(): void {
  if (clickHooked) return;
  clickHooked = true;
  window.addEventListener('click', onClick, true);
}

export function armTrailingClickSwallow(): void {
  if (typeof window === 'undefined' || armed) return;
  armed = true;
  hookClick();
  window.addEventListener('pointerup', expire, true);
  window.addEventListener('pointercancel', expire, true);
}

function related(from: EventTarget | null, to: EventTarget | null): boolean {
  if (!(from instanceof Node) || !(to instanceof Node)) return true;
  return from === to || from.contains(to) || to.contains(from);
}

function trackPointerDown(event: PointerEvent): void {
  touchDown = event.pointerType === 'mouse' ? null : event.target;
}

function forgetPointer(): void {
  touchDown = null;
}

function onContextMenu(): void {
  if (touchDown !== null) armTrailingClickSwallow();
}

function onClick(event: MouseEvent): void {
  const from = touchDown;
  touchDown = null;
  if (armed) {
    swallow(event);
    disarm();
    return;
  }
  if (from !== null && !related(from, event.target)) swallow(event);
}

export function guardTouchClicks(): () => void {
  window.addEventListener('pointerdown', trackPointerDown, true);
  window.addEventListener('pointercancel', forgetPointer, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  hookClick();
  return () => {
    window.removeEventListener('pointerdown', trackPointerDown, true);
    window.removeEventListener('pointercancel', forgetPointer, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    touchDown = null;
    disarm();
  };
}
