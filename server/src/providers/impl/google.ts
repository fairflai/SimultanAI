// Google Gemini Live API (Google AI Studio key), model gemini-3.5-live-translate-preview.
//
// Facts that are costly to get wrong:
// - The setup message must be the first frame; the server answers {setupComplete:{}}.
// - JSON frames may arrive as binary: always JSON.parse(data.toString()).
// - The API key travels in the URL: never log the URL.
// - No expiry is announced. Audio-only sessions last 15 min and the connection ~10 min; a
//   goAway {timeLeft} frame precedes the close. We budget SESSION_MS from setupComplete and
//   rotate on goAway as a safety net.
// - Input is PCM16 16 kHz as documented (declared in the mimeType of every audio frame).
//   Output is PCM16 24 kHz, the pipeline's playback format, so nothing is resampled here.
import WebSocket from 'ws';
import { Provider, rawToString, type HealthRequest, type ProviderEvent } from '../provider.ts';

const URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const SESSION_MS = 10 * 60_000; // connection lifetime budget, the tighter of the two limits

// The subset of the wire messages we read
interface GeminiMessage {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    outputTranscription?: { text?: string; languageCode?: string };
  };
  goAway?: { timeLeft?: string }; // protobuf Duration string like "10s"
}

export class GoogleProvider extends Provider {
  readonly name = 'google';
  readonly model = process.env.GEMINI_MODEL || 'gemini-3.5-live-translate-preview';
  readonly requiredEnv = ['GEMINI_API_KEY'];
  readonly capabilities = { subtitles: true };
  readonly inputSampleRate = 16000; // documented Live API input rate; client/_common.sh must match
  readonly rotateMarginMs = 2 * 60_000;

  // The key travels in the URL here too: never log it
  healthRequest(): HealthRequest {
    return { url: `${MODELS_URL}/${encodeURIComponent(this.model)}?key=${encodeURIComponent(process.env.GEMINI_API_KEY ?? '')}` };
  }

  connect(lang: string): WebSocket {
    const ws = new WebSocket(`${URL}?key=${encodeURIComponent(process.env.GEMINI_API_KEY ?? '')}`);
    ws.on('open', () => ws.send(JSON.stringify(this.setupMessage(lang))));
    return ws;
  }

  // First frame of a session. outputAudioTranscription is a top-level setup field (API reference),
  // not part of generationConfig as the Live translation guide example shows: nesting it closes with 1007.
  setupMessage(lang: string): object {
    return {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: lang },
        },
        outputAudioTranscription: {},
      },
    };
  }

  sendAudio(ws: WebSocket, pcm: Buffer): void {
    ws.send(JSON.stringify({
      realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${this.inputSampleRate}` } },
    }));
  }

  parse(data: WebSocket.RawData): ProviderEvent[] {
    let msg: GeminiMessage;
    try { msg = JSON.parse(rawToString(data)) as GeminiMessage; } catch { return []; }
    if (msg.setupComplete) {
      return [{ kind: 'expires', at: Date.now() + SESSION_MS }, { kind: 'ready' }];
    }
    if (msg.serverContent) {
      const sc = msg.serverContent;
      const out: ProviderEvent[] = [];
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) out.push({ kind: 'audio', pcm: Buffer.from(part.inlineData.data, 'base64') });
      }
      if (sc.outputTranscription?.text) out.push({ kind: 'subtitle', text: sc.outputTranscription.text });
      if (out.length === 0) out.push({ kind: 'unknown', type: `serverContent:${Object.keys(sc).join('+')}+${Object.keys(msg).join('+')}`, raw: msg });
      return out;
    }
    if (msg.goAway) {
      return [{ kind: 'goaway', msLeft: parseFloat(msg.goAway.timeLeft ?? '') * 1000 || 0 }];
    }
    return [{ kind: 'unknown', type: Object.keys(msg).join('+'), raw: msg }];
  }
}
