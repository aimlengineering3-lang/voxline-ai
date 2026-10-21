const SAMPLE_RATE = 16000; // Gemini input rate

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export class MicCapture {
  // onChunk(base64Pcm16, level) where level is RMS loudness in 0..1
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.ctx.audioWorklet.addModule("/pcm-capture.worklet.js");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (e) => {
      const pcm = new Int16Array(e.data);
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i] / 32768;
        sum += v * v;
      }
      const level = Math.sqrt(sum / pcm.length);
      this.onChunk(toBase64(e.data), level);
    };
    this.source.connect(this.node);
  }

  async stop() {
    this.node?.port.close();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = this.stream = this.source = this.node = null;
  }
}