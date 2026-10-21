// Collects mic samples into 640-sample blocks (40 ms at 16 kHz),
// converts Float32 to Int16 and posts the raw buffer to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(640);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;

    let i = 0;
    while (i < input.length) {
      const n = Math.min(input.length - i, this.buf.length - this.len);
      this.buf.set(input.subarray(i, i + n), this.len);
      this.len += n;
      i += n;

      if (this.len === this.buf.length) {
        const pcm = new Int16Array(this.len);
        for (let j = 0; j < this.len; j++) {
          const s = Math.max(-1, Math.min(1, this.buf[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);