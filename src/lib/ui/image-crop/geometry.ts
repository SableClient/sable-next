export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;
export type Corner = 'nw' | 'ne' | 'sw' | 'se';

export const MAX_ZOOM = 8;

export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation % 180 === 0 ? size : { width: size.height, height: size.width };
}

export function fitFrame(stage: Size, aspect: number, inset: number): Rect {
  const room = {
    width: Math.max(1, stage.width - inset * 2),
    height: Math.max(1, stage.height - inset * 2),
  };
  const width = Math.min(room.width, room.height * aspect);
  const height = width / aspect;
  return {
    x: (stage.width - width) / 2,
    y: (stage.height - height) / 2,
    width,
    height,
  };
}

export function coverScale(image: Size, frame: Size): number {
  return Math.max(frame.width / image.width, frame.height / image.height);
}

export function clampView(view: View, image: Size, frame: Rect): View {
  const min = coverScale(image, frame);
  const scale = Math.min(Math.max(view.scale, min), min * MAX_ZOOM);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    scale,
    x: Math.min(frame.x, Math.max(frame.x + frame.width - width, view.x)),
    y: Math.min(frame.y, Math.max(frame.y + frame.height - height, view.y)),
  };
}

export function fitView(image: Size, frame: Rect): View {
  const scale = coverScale(image, frame);
  return {
    scale,
    x: frame.x + (frame.width - image.width * scale) / 2,
    y: frame.y + (frame.height - image.height * scale) / 2,
  };
}

export function zoomView(
  view: View,
  image: Size,
  frame: Rect,
  scale: number,
  anchor: { x: number; y: number }
): View {
  const min = coverScale(image, frame);
  const next = Math.min(Math.max(scale, min), min * MAX_ZOOM);
  const ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    },
    image,
    frame
  );
}

export function panView(view: View, image: Size, frame: Rect, dx: number, dy: number): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, frame);
}

/** The frame in the rotated source's pixels. */
export function sourceRect(view: View, frame: Rect): Rect {
  return {
    x: (frame.x - view.x) / view.scale,
    y: (frame.y - view.y) / view.scale,
    width: frame.width / view.scale,
    height: frame.height / view.scale,
  };
}

export function resizeFrame(
  start: Rect,
  corner: Corner,
  dx: number,
  dy: number,
  bounds: Rect,
  min: number
): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (corner === 'nw' || corner === 'sw') left = clamp(left + dx, bounds.x, right - min);
  else right = clamp(right + dx, left + min, bounds.x + bounds.width);
  if (corner === 'nw' || corner === 'ne') top = clamp(top + dy, bounds.y, bottom - min);
  else bottom = clamp(bottom + dy, top + min, bounds.y + bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
