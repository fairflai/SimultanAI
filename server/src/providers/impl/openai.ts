// OpenAI Realtime translation: wss://api.openai.com/v1/realtime/translations, model gpt-realtime-translate.
// A session lives 60 minutes; the exact expiry arrives in session.created.expires_at (unix seconds).
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { Provider, rawToString, type HealthRequest, type ProviderEvent } from '../provider.ts';

const URL = 'wss://api.openai.com/v1/realtime/translations';
const MODELS_URL = 'https://api.openai.com/v1/models';
const SAFETY_ID = createHash('sha256').update('poc-event-translation').digest('hex');

// The subset of the wire events we read
interface OpenAIEvent {
  type: string;
  session?: { expires_at?: number; audio?: { output?: { language?: string } } };
  delta?: string;
  error?: unknown;
}

export class OpenAIProvider extends Provider {
  readonly name = 'openai';
  readonly model = process.env.OPENAI_MODEL || 'gpt-realtime-translate';
  readonly requiredEnv = ['OPENAI_API_KEY'];
  readonly capabilities = { subtitles: true };
  readonly inputSampleRate = 24000; // the only rate the translation endpoint accepts
  readonly rotateMarginMs = 5 * 60_000;

  healthRequest(): HealthRequest {
    return {
      url: `${MODELS_URL}/${encodeURIComponent(this.model)}`,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    };
  }

  connect(lang: string): WebSocket {
    const ws = new WebSocket(`${URL}?model=${encodeURIComponent(this.model)}`, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Safety-Identifier': SAFETY_ID,
      },
    });
    ws.on('open', () => ws.send(JSON.stringify(this.setupMessage(lang))));
    return ws;
  }

  // First message of a session: selects the output language
  setupMessage(lang: string): object {
    return { type: 'session.update', session: { audio: { output: { language: lang } } } };
  }

  sendAudio(ws: WebSocket, pcm: Buffer): void {
    ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: pcm.toString('base64') }));
  }

  override close(ws: WebSocket): void {
    ws.send(JSON.stringify({ type: 'session.close' }));
    ws.close();
  }

  parse(data: WebSocket.RawData, lang: string): ProviderEvent[] {
    let ev: OpenAIEvent;
    try { ev = JSON.parse(rawToString(data)) as OpenAIEvent; } catch { return []; }
    switch (ev.type) {
      case 'session.created':
        return ev.session?.expires_at ? [{ kind: 'expires', at: ev.session.expires_at * 1000 }] : [];
      case 'session.updated': {
        const got = ev.session?.audio?.output?.language;
        return got === lang
          ? [{ kind: 'ready' }]
          : [{ kind: 'error', message: `session configured with wrong language ${got}` }];
      }
      case 'session.output_audio.delta':
        return [{ kind: 'audio', pcm: Buffer.from(ev.delta ?? '', 'base64') }];
      case 'session.output_transcript.delta':
        return [{ kind: 'subtitle', text: ev.delta ?? '' }];
      case 'error':
        return [{ kind: 'error', message: JSON.stringify(ev.error ?? ev) }];
      default:
        return [{ kind: 'unknown', type: ev.type, raw: ev }];
    }
  }
}
