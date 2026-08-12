export const SWIPE_THRESHOLD = 64;
export const VELOCITY_THRESHOLD = 0.3;

export type SwipeMode = 'pending' | 'horizontal' | 'vertical';
export type SwipeDirection = 'left' | 'right';

export interface SwipeGesture {
  startX: number;
  startY: number;
  startPosition: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  mode: SwipeMode;
}

export interface SwipeUpdate {
  distanceX: number;
  distanceY: number;
  mode: SwipeMode;
}

export interface SwipeResult {
  handled: boolean;
  direction: SwipeDirection | undefined;
  distanceX: number;
  velocityX: number;
}

export function startSwipeGesture(
  event: TouchEvent,
  startPosition: number
): SwipeGesture | undefined {
  if (event.touches.length !== 1) return undefined;

  const touch = event.touches[0];

  return {
    startX: touch.clientX,
    startY: touch.clientY,
    startPosition,
    lastX: touch.clientX,
    lastTime: event.timeStamp,
    velocityX: 0,
    mode: 'pending',
  };
}

export function updateSwipeGesture(
  gesture: SwipeGesture,
  event: TouchEvent
): SwipeUpdate | undefined {
  if (event.touches.length !== 1) return undefined;

  const touch = event.touches[0];

  const distanceX = touch.clientX - gesture.startX;
  const distanceY = touch.clientY - gesture.startY;
  const elapsed = event.timeStamp - gesture.lastTime;
  if (elapsed > 0) {
    gesture.velocityX = (touch.clientX - gesture.lastX) / elapsed;
    gesture.lastX = touch.clientX;
    gesture.lastTime = event.timeStamp;
  }

  if (gesture.mode === 'pending') {
    if (distanceX === 0 && distanceY === 0) {
      return { distanceX, distanceY, mode: gesture.mode };
    }
    gesture.mode = Math.abs(distanceX) <= Math.abs(distanceY) ? 'vertical' : 'horizontal';
  }

  return { distanceX, distanceY, mode: gesture.mode };
}

export function finishSwipeGesture(
  gesture: SwipeGesture,
  currentPosition: number,
  cancelled = false
): SwipeResult {
  const distanceX = currentPosition - gesture.startPosition;
  const handled = !cancelled && gesture.mode === 'horizontal';

  if (!handled) {
    return {
      handled: false,
      direction: undefined,
      distanceX,
      velocityX: gesture.velocityX,
    };
  }

  let direction: SwipeDirection | undefined;
  if (gesture.velocityX > VELOCITY_THRESHOLD) {
    direction = 'right';
  } else if (gesture.velocityX < -VELOCITY_THRESHOLD) {
    direction = 'left';
  } else if (Math.abs(distanceX) >= SWIPE_THRESHOLD) {
    direction = distanceX > 0 ? 'right' : 'left';
  }

  return { handled: true, direction, distanceX, velocityX: gesture.velocityX };
}
