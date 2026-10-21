const SAMPLE_RATE = 24000; // Gemini output rate

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.onState = null; // called with "active" or "idle"
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    // created synchronously, inside the user's click
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.audioWorklet.addModule("/pcm-player.worklet.js");
    this.node = new AudioWorkletNode(this.ctx, "pcm-player");
    this.node.port.onmessage = (e) => this.onState?.(e.data);
    this.node.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  // base64 of 16-bit little-endian mono PCM
  enqueue(base64) {
    if (!this.node) return;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const samples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768;
    this.node.port.postMessage({ type: "chunk", samples }, [samples.buffer]);
  }

  clear() {
    this.node?.port.postMessage({ type: "clear" });
  }
}