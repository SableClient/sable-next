const MISORDERED = [5, 7, 8];

export function reorderKeyframe(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const starts: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    const start = i > 0 && bytes[i - 1] === 0 ? i - 1 : i;
    if ((bytes[i + 3] & 0x1f) !== MISORDERED[starts.length]) return null;
    if (starts.length === 0 && start !== 0) return null;
    starts.push(start);
    i += 2;
  }
  if (starts.length !== MISORDERED.length) return null;

  const sps = starts[1];
  const ordered = new Uint8Array(bytes.length);
  ordered.set(bytes.subarray(sps));
  ordered.set(bytes.subarray(0, sps), bytes.length - sps);
  return ordered;
}

export function keyframeFix(): TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame> {
  return new TransformStream({
    transform(frame, controller) {
      if (frame.type === 'key') {
        const ordered = reorderKeyframe(new Uint8Array(frame.data));
        if (ordered) frame.data = ordered.buffer;
      }
      controller.enqueue(frame);
    },
  });
}
