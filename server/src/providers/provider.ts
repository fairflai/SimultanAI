// Abstract translation provider: the vocabulary of ONE wire session with a vendor.
//
// A provider is stateless and shared by every Translator. It knows the endpoint, the auth,
// the setup payload, how to wrap an audio chunk and how to turn a raw WebSocket message into
// normalized events. The Translator owns the session lifecycle (queue, rotation, reconnect)
// and never sees a vendor string.
import type WebSocket from 'ws';

// Normalized events returned by parse(). Translator.handle() switches exhaustively on `kind`.
export type ProviderEvent =
  | { kind: 'ready' } // session configured, ready for audio
  | { kind: 'expires'; at: number } // session/connection expiry, ms epoch (drives rotation)
  | { kind: 'audio'; pcm: Buffer } // translated audio, PCM16 mono 24 kHz
  | { kind: 'subtitle'; text: string } // translated transcript delta
  | { kind: 'error'; message: string } // vendor error (on a pending session it aborts the open)
  | { kind: 'goaway'; msLeft: number } // vendor will close the connection soon: rotate now
  | { kind: 'unknown'; type: string; raw: unknown }; // unmapped vendor event, logged once per type

export interface Capabilities {
  subtitles: boolean;
}

// A plain HTTP GET that index.ts performs for GET /health
export interface HealthRequest {
  url: string;
  headers?: Record<string, string>;
}

// ws delivers Buffer by default, but RawData also admits ArrayBuffer and Buffer[]: decode all three
export function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

export abstract class Provider {
  abstract readonly name: string; // shown in /info and logs
  abstract readonly model: string; // shown in /info
  abstract readonly requiredEnv: readonly string[]; // validated at boot by index.ts
  abstract readonly capabilities: Capabilities;
  abstract readonly inputSampleRate: number; // PCM16 mono rate expected by sendAudio(); client/_common.sh must match
  abstract readonly rotateMarginMs: number; // how long before 'expires.at' the replacement session is opened

  // Zero-cost liveness probe: a GET of the model's catalogue entry (models.get). It proves network,
  // API key and model name, and bills nothing because no session is opened and no token is processed.
  // It must NEVER open a session or send content: realtime sessions are billed per minute, silence included.
  abstract healthRequest(): HealthRequest;

  // Opens a WebSocket for one target language and sends the vendor setup on 'open'.
  abstract connect(lang: string): WebSocket;

  // Sends one chunk of PCM16 mono audio at inputSampleRate on an open session.
  abstract sendAudio(ws: WebSocket, pcm: Buffer): void;

  // Raw ws message → normalized events. Must never throw.
  abstract parse(data: WebSocket.RawData, lang: string): ProviderEvent[];

  // Closes an OPEN session gracefully.
  close(ws: WebSocket): void {
    ws.close();
  }
}
