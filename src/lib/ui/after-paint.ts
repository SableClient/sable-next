export function afterNextPaint(callback: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(callback);
  });
  return () => {
    cancelAnimationFrame(frame);
  };
}
