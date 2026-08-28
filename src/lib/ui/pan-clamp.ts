export interface Size {
  width: number;
  height: number;
}

export interface Vector2 {
  x: number;
  y: number;
}

export function clampPan(pan: Vector2, container: Size, content: Size): Vector2 {
  const maxX = Math.max(0, (content.width - container.width) / 2);
  const maxY = Math.max(0, (content.height - container.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)) || 0,
    y: Math.min(maxY, Math.max(-maxY, pan.y)) || 0,
  };
}
