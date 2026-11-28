/// <reference lib="webworker" />

import { keyframeFix } from '#lib/features/call/h264-keyframe.js';

declare const self: DedicatedWorkerGlobalScope;

type EncodeMessage = {
  kind?: string;
  data?: { codec?: string; readableStream?: ReadableStream<RTCEncodedVideoFrame> };
};

self.addEventListener('message', ({ data: message }: MessageEvent<EncodeMessage>) => {
  const data = message.data;
  if (message.kind !== 'encode' || data?.codec !== 'h264' || !data.readableStream) return;
  data.readableStream = data.readableStream.pipeThrough(keyframeFix());
});
