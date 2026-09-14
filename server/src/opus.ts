// Outbound audio codec. The provider emits PCM16 mono 24 kHz; broadcast.ts re-frames it into 20 ms
// packets and Opus-encodes them once per language, so every listener receives the same packets and
// decodes them with WebCodecs (web/app/page.tsx): about 32 kbit/s per listener instead of 384 raw.
//
// libopus-wasm is libopus compiled to WASM, inlined in one ES module: no native build, no toolchain
// in the Alpine image, the same code on the dev machine and in production. The native alternatives
// were ruled out on purpose: @discordjs/opus has no prebuild for Node 24 (npm install would compile)
// and @evan/opus ships a glibc binary that on Alpine silently falls back to its own WASM.
import { Application, Signal, createEncoder, type OpusEncoderHandle } from 'libopus-wasm';

export const SAMPLE_RATE = 24000; // provider output rate, see ProviderEvent 'audio'
export const PACKET_MS = 20;
export const PACKET_SAMPLES = SAMPLE_RATE * PACKET_MS / 1000;
const PACKET_BYTES = PACKET_SAMPLES * 2;
const BITRATE = 32_000; // speech at 24 kHz is transparent well below this

// The WASM module loads asynchronously: encoders are created up front (broadcast.init) so that
// push() stays synchronous on the provider's message path
export async function createOpusStream(emit: (packet: Uint8Array) => void): Promise<OpusStream> {
  const encoder = await createEncoder({
    sampleRate: SAMPLE_RATE, channels: 1, frameSize: PACKET_SAMPLES,
    application: Application.Voip, signal: Signal.Voice, bitrate: BITRATE,
  });
  return new OpusStream(encoder, emit);
}

export class OpusStream {
  private readonly encoder: OpusEncoderHandle;
  private readonly emit: (packet: Uint8Array) => void;
  private tail: Buffer = Buffer.alloc(0); // bytes not yet forming a whole packet

  constructor(encoder: OpusEncoderHandle, emit: (packet: Uint8Array) => void) {
    this.encoder = encoder;
    this.emit = emit;
  }

  // The remainder that does not fill a packet waits for the next chunk: padding it with silence and
  // sending it would put a jump to zero (a click) and a gap inside the speech every time the provider
  // pauses between chunks, which Gemini does often. Only the last <20 ms of the whole event are lost.
  push(pcm: Buffer): void {
    const buf = this.tail.length ? Buffer.concat([this.tail, pcm]) : pcm;
    let offset = 0;
    for (; offset + PACKET_BYTES <= buf.length; offset += PACKET_BYTES) {
      this.emit(this.encoder.encode(buf.subarray(offset, offset + PACKET_BYTES)));
    }
    this.tail = buf.subarray(offset);
  }
}
