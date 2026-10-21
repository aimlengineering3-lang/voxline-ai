class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; // Float32Array chunks
    this.offset = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data.type === "chunk") {
        this.queue.push(e.data.samples);
        if (!this.playing) {
          this.playing = true;
          this.port.postMessage("active");
        }
      } else if (e.data.type === "clear") {
        this.queue = [];
        this.offset = 0;
        if (this.playing) {
          this.playing = false;
          this.port.postMessage("idle");
        }
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const chunk = this.queue[0];
      const n = Math.min(out.length - i, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + n), i);
      i += n;
      this.offset += n;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (this.playing && this.queue.length === 0 && i < out.length) {
      this.playing = false;
      this.port.postMessage("idle");
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);