// DeepL Voice API (paid API plan), speech-to-speech over WebSocket (no model choice: one pipeline).
//
// Facts that are costly to get wrong:
// - Two steps: POST /v3/voice/realtime returns a streaming_url and a one-time token, then the
//   WebSocket opens on that URL. connect() must return a socket synchronously, so it returns a
//   DeepLSocket that stands in for the real one until it exists (the Provider contract stays sync).
// - No "ready" message exists: the session is ready when the WebSocket opens, so DeepLSocket emits
//   an internal {_open:{}} message that parse() turns into 'ready'.
// - The token travels in the URL: never log the URL. Reusing it terminates the session.
// - Session options are fixed at creation: one session = one target language, at most one speech
//   target per session anyway.
// - No expiry is announced; the session dies after 30 s without audio (the Translator always feeds it).
// - Every message is an object with a single key naming its type, no "type" field.
// - Input is PCM16 16 kHz in chunks of 50-250 ms (max 1 s or 100 KB). Output is PCM16 24 kHz,
//   the pipeline's playback format.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Provider, rawToString, type HealthRequest, type ProviderEvent } from '../provider.ts';

const SESSION_URL = 'https://api.deepl.com/v3/voice/realtime';
const USAGE_URL = 'https://api.deepl.com/v2/usage';
const OPEN = Buffer.from(JSON.stringify({ _open: {} }));

// The subset of the wire messages we read
interface DeepLMessage {
  _open?: object;
  target_media_chunk?: { data?: string[] };
  target_transcript_update?: { concluded?: { text?: string }[] };
  error?: { error_code?: string | number; error_message?: string };
}

// Stands in for the WebSocket while the session is being created, then forwards to it.
// It exposes only what Translator and DeepLProvider use: on(), readyState, send(), close(), terminate().
export class DeepLSocket extends EventEmitter {
  ws: WebSocket | null = null;
  aborted = false;

  get readyState(): number {
    return this.ws?.readyState ?? (this.aborted ? WebSocket.CLOSED : WebSocket.CONNECTING);
  }

  attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on('open', () => this.emit('message', OPEN));
    ws.on('message', (data) => this.emit('message', data));
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => this.emit('close', code, reason));
  }

  // Session creation failed: report it as a provider error, the Translator then terminates and retries
  fail(message: string): void {
    if (this.aborted) return;
    this.emit('message', Buffer.from(JSON.stringify({ error: { error_message: message } })));
    this.terminate();
  }

  send(data: string): void {
    this.ws?.send(data);
  }

  close(): void {
    if (this.ws) this.ws.close();
    else this.terminate();
  }

  // Before the WebSocket exists: mark it aborted so it is never opened, and close like ws would
  terminate(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (this.ws) this.ws.terminate();
    else this.emit('close', 1006, Buffer.alloc(0));
  }
}

export class DeepLProvider extends Provider {
  readonly name = 'deepl';
  readonly model = 'voice';
  readonly requiredEnv = ['DEEPL_API_KEY'];
  readonly capabilities = { subtitles: true };
  readonly inputSampleRate = 16000; // the documented PCM rate; client/_common.sh must match
  readonly inputChunkMs = 100; // documented range 50-250 ms
  readonly rotateMarginMs = 0; // never used: no 'expires' event

  // Reading the character usage proves network and key, bills nothing
  healthRequest(): HealthRequest {
    return { url: USAGE_URL, headers: { Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}` } };
  }

  connect(lang: string): WebSocket {
    const sock = new DeepLSocket();
    void this.open(sock, lang);
    return sock as unknown as WebSocket;
  }

  async open(sock: DeepLSocket, lang: string): Promise<void> {
    let session: { streaming_url: string; token: string };
  
    try {
      const res = await fetch(SESSION_URL, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.setupMessage(lang)),
      });

      if (!res.ok) throw new Error(`session request HTTP ${res.status}: ${await res.text()}`);
      session = await res.json() as typeof session;
    } catch (err) {
      sock.fail((err as Error).message);
      return;
    }

    // Terminated while the POST was in flight: never open the session
    if (sock.aborted) return;

    sock.attach(new WebSocket(`${session.streaming_url}?token=${encodeURIComponent(session.token)}`));
  }

  // Body of the session request: the target language is spoken (target_media_languages adds it to the
  // text targets too, so subtitles come for free); the source language is auto-detected.
  setupMessage(lang: string): object {
    return {
      source_media_content_type: `audio/pcm;encoding=s16le;rate=${this.inputSampleRate}`,
      target_media_languages: [lang],
      target_media_content_type: 'audio/pcm;encoding=s16le;rate=24000',
    };
  }

  sendAudio(ws: WebSocket, pcm: Buffer): void {
    ws.send(JSON.stringify({ source_media_chunk: { data: pcm.toString('base64') } }));
  }

  override close(ws: WebSocket): void {
    ws.send(JSON.stringify({ end_of_source_media: {} }));
    ws.close();
  }

  parse(data: WebSocket.RawData): ProviderEvent[] {
    let msg: DeepLMessage;
    try { msg = JSON.parse(rawToString(data)) as DeepLMessage; } catch { return []; }
    if (msg._open) return [{ kind: 'ready' }];
  
    if (msg.target_media_chunk) {
      const pcm = Buffer.concat((msg.target_media_chunk.data ?? []).map((b) => Buffer.from(b, 'base64')));
      return pcm.length ? [{ kind: 'audio', pcm }] : [];
    }
  
    if (msg.target_transcript_update) {
      // Concluded segments only: tentative ones get rewritten. Segments carry their own leading space
      const text = (msg.target_transcript_update.concluded ?? []).map((s) => s.text ?? '').join('');
      return text ? [{ kind: 'subtitle', text }] : [];
    }
  
    if (msg.error) {
      const { error_code: code, error_message: message } = msg.error;
      return [{ kind: 'error', message: code === undefined ? `${message}` : `${code}: ${message}` }];
    }
  
    // The source transcript and the end_of_* markers carry nothing the pipeline uses
    const type = Object.keys(msg).join('+');
    if (type === 'source_transcript_update' || type.startsWith('end_of_')) return [];
  
    return [{ kind: 'unknown', type, raw: msg }];
  }
}
