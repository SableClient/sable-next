const PRIME_FRAMES = 1440;
const MAX_FRAMES = 12000;

class ScreenAudioPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0;
    this.buffered = 0;
    this.primed = false;
    this.port.onmessage = ({ data }) => {
      this.chunks.push(data);
      this.buffered += data.length / 2;
      while (this.buffered > MAX_FRAMES && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        this.buffered -= dropped.length / 2 - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.primed && this.buffered >= PRIME_FRAMES) this.primed = true;
    if (!this.primed) return true;
    for (let frame = 0; frame < left.length; frame += 1) {
      const chunk = this.chunks[0];
      if (!chunk) {
        this.primed = false;
        break;
      }
      left[frame] = chunk[this.offset * 2];
      right[frame] = chunk[this.offset * 2 + 1];
      this.offset += 1;
      this.buffered -= 1;
      if (this.offset * 2 >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('sable-screen-audio-player', ScreenAudioPlayer);
