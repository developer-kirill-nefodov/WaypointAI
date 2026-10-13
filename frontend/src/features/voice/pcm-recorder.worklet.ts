// AudioWorklet that converts microphone input to 24 kHz mono PCM16 chunks of about 100 ms.
// It runs in the AudioWorkletGlobalScope, so the scope globals are declared locally.
declare const sampleRate: number;
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessorBase): void;
declare class AudioWorkletProcessorBase {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: typeof AudioWorkletProcessorBase;

const TARGET_SAMPLE_RATE = 24_000;
const CHUNK_SAMPLES = 2_400;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  #ratio = sampleRate / TARGET_SAMPLE_RATE;
  #position = 0;
  #sum = 0;
  #count = 0;
  #chunk = new Int16Array(CHUNK_SAMPLES);
  #chunkLength = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      // Box-filter decimation keeps aliasing low for typical 44.1/48 kHz inputs.
      this.#sum += sample;
      this.#count += 1;
      this.#position += 1;
      while (this.#position >= this.#ratio) {
        this.#push(this.#sum / this.#count);
        this.#position -= this.#ratio;
        if (this.#position < this.#ratio) {
          this.#sum = 0;
          this.#count = 0;
        }
      }
    }
    return true;
  }

  #push(value: number): void {
    const clamped = Math.max(-1, Math.min(1, value));
    this.#chunk[this.#chunkLength] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.#chunkLength += 1;
    if (this.#chunkLength < CHUNK_SAMPLES) return;
    const buffer = this.#chunk.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.#chunk = new Int16Array(CHUNK_SAMPLES);
    this.#chunkLength = 0;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);

export {};
