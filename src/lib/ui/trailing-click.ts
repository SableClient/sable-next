const EXPIRY_MS = 500;

let armed = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
let touchDown: EventTarget | null = null;
let touchExpiry: ReturnType<typeof setTimeout> | undefined;
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
  window.removeEventListener('touchend', expire, true);
  window.removeEventListener('touchcancel', expire, true);
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
  window.addEventListener('touchend', expire, true);
  window.addEventListener('touchcancel', expire, true);
}

function related(from: EventTarget | null, to: EventTarget | null): boolean {
  if (!(from instanceof Node) || !(to instanceof Node)) return true;
  return from === to || from.contains(to) || to.contains(from);
}

function secondaryPointer(event: PointerEvent): boolean {
  const { isPrimary } = event as Partial<PointerEvent>;
  return isPrimary === false;
}

function trackPointerDown(event: PointerEvent): void {
  if (secondaryPointer(event)) return;
  if (armed) disarm();
  forgetPointer();
  touchDown = event.pointerType === 'mouse' ? null : event.target;
}

function releasePointer(): void {
  if (touchDown === null || touchExpiry) return;
  touchExpiry = setTimeout(forgetPointer, EXPIRY_MS);
}

function forgetPointer(): void {
  if (touchExpiry) clearTimeout(touchExpiry);
  touchExpiry = undefined;
  touchDown = null;
}

function onContextMenu(): void {
  if (touchDown !== null) armTrailingClickSwallow();
}

function onClick(event: MouseEvent): void {
  const from = touchDown;
  forgetPointer();
  if (armed) {
    swallow(event);
    disarm();
    return;
  }
  if (from !== null && !related(from, event.target)) swallow(event);
}

export function guardTouchClicks(): () => void {
  window.addEventListener('pointerdown', trackPointerDown, true);
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', forgetPointer, true);
  window.addEventListener('touchend', releasePointer, true);
  window.addEventListener('touchcancel', forgetPointer, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  hookClick();
  return () => {
    window.removeEventListener('pointerdown', trackPointerDown, true);
    window.removeEventListener('pointerup', releasePointer, true);
    window.removeEventListener('pointercancel', forgetPointer, true);
    window.removeEventListener('touchend', releasePointer, true);
    window.removeEventListener('touchcancel', forgetPointer, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    forgetPointer();
    disarm();
  };
}
