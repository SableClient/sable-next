/// <reference lib="webworker" />

import { keyframeFix } from '#lib/features/call/h264-keyframe.js';

declare const self: DedicatedWorkerGlobalScope & {
  onrtctransform: ((event: RTCTransformEvent) => void) | null;
};

self.onrtctransform = ({ transformer }) => {
  const writable = transformer.writable as WritableStream<RTCEncodedVideoFrame>;
  void transformer.readable.pipeThrough(keyframeFix()).pipeTo(writable);
};
