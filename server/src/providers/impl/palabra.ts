// Palabra.ai Speech-to-Speech Translation API, WebSocket transport (no model choice: one pipeline).
//
// Facts that are costly to get wrong:
// - Connecting with the API key creates the streaming session; it lives as long as the connection,
//   so no expiry is announced and nothing rotates.
// - The source language must be declared (PALABRA_SOURCE_LANG): "auto" exists but is experimental.
// - No audio before task_status {set_task, running}: the Translator queues until 'ready'.
// - Input must arrive at real-time pace in input_audio_data payloads of at least 1 KB of base64:
//   smaller frames get VALIDATION_ERROR and too many frames RATE_LIMIT_EXCEEDED, hence inputChunkMs.
// - "data" may arrive double-encoded as a JSON string.
// - Output is PCM16 24 kHz mono (fixed), the pipeline's playback format.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { Provider, rawToString, type HealthRequest, type ProviderEvent } from '../provider.ts';

// The path segment after streaming-api/ is any random string: it spreads connections across servers
const URL = 'wss://streaming.palabra.ai/streaming-api/{hash}/v1/speech-to-speech/stream';
const SESSIONS_URL = 'https://api.palabra.ai/session-storage/sessions';

// The subset of the wire messages we read
interface PalabraData {
  command?: string;
  event?: string;
  task_status?: string;
  data?: string; // output_audio_data: base64 PCM
  transcription?: { text?: string };
  code?: string;
  desc?: string;
}
interface PalabraMessage {
  message_type: string;
  data?: string | PalabraData;
}

export class PalabraProvider extends Provider {
  readonly name = 'palabra';
  readonly model = 'speech-to-speech';
  readonly requiredEnv = ['PALABRA_API_KEY', 'PALABRA_SOURCE_LANG'];
  readonly capabilities = { subtitles: true };
  readonly inputSampleRate = 24000; // accepted range 16000-48000, 24000 like the output; client/_common.sh must match
  readonly inputChunkMs = 320; // the documented optimal chunk, 15 KB: above the 1 KB minimum, ~3 frames/s
  readonly rotateMarginMs = 0; // never used: no 'expires' event

  // Listing the sessions proves network and key, bills nothing
  healthRequest(): HealthRequest {
    return {
      url: `${SESSIONS_URL}?page_size=1`,
      headers: { Authorization: `Bearer ${process.env.PALABRA_API_KEY}` },
    };
  }

  // Key in the header, not in the ?token= of the docs, so the URL is safe to log
  connect(lang: string): WebSocket {
    const ws = new WebSocket(URL.replace('{hash}', randomUUID()), {
      headers: { Authorization: `Bearer ${process.env.PALABRA_API_KEY}` },
    });
    ws.on('open', () => ws.send(JSON.stringify(this.setupMessage(lang))));
    return ws;
  }

  // set_task: one target language per session, only final translations as subtitles.
  // Latency settings: the defaults wait for 0.7 s of silence to confirm a segment and buffer 5 s of speech,
  // so a speaker with short pauses was heard ~3.5 s late. Partial translation, a 0.5 s threshold (low end of
  // the documented recommended range), the sentence splitter and the minimum TTS queue cut that down.
  setupMessage(lang: string): object {
    return {
      message_type: 'set_task',
      data: {
        input_stream: {
          content_type: 'audio',
          source: { type: 'ws', format: 'pcm_s16le', sample_rate: this.inputSampleRate, channels: 1 },
        },
        output_stream: { content_type: 'audio', target: { type: 'ws', format: 'pcm_s16le' } },
        pipeline: {
          transcription: {
            source_language: process.env.PALABRA_SOURCE_LANG,
            segment_confirmation_silence_threshold: 0.5,
            sentence_splitter: { enabled: true },
          },
          translations: [{ target_language: lang, translate_partial_transcriptions: true, speech_generation: {} }],
          translation_queue_configs: {
            global: { desired_queue_level_ms: 2000, max_queue_level_ms: 6000, auto_tempo: true },
          },
          allowed_message_types: ['translated_transcription'],
        },
      },
    };
  }

  sendAudio(ws: WebSocket, pcm: Buffer): void {
    ws.send(JSON.stringify({ message_type: 'input_audio_data', data: { data: pcm.toString('base64') } }));
  }

  override close(ws: WebSocket): void {
    ws.send(JSON.stringify({ message_type: 'end_task', data: { force: false } }));
    ws.close();
  }

  parse(data: WebSocket.RawData): ProviderEvent[] {
    let msg: PalabraMessage;
    let d: PalabraData;
    try {
      msg = JSON.parse(rawToString(data)) as PalabraMessage;
      d = (typeof msg.data === 'string' ? JSON.parse(msg.data) as PalabraData : msg.data) ?? {};
    } catch { return []; }
    switch (msg.message_type) {
      case 'task_status':
        if (d.command === 'set_task' && d.task_status === 'running') return [{ kind: 'ready' }];
        return [{ kind: 'unknown', type: `task_status:${d.command}:${d.event}`, raw: msg }];
      case 'output_audio_data':
        return [{ kind: 'audio', pcm: Buffer.from(d.data ?? '', 'base64') }];
      case 'translated_transcription':
        // A whole segment, not a delta: the trailing space separates it from the next one
        return d.transcription?.text ? [{ kind: 'subtitle', text: `${d.transcription.text} ` }] : [];
      case 'error':
        return [{ kind: 'error', message: `${d.code}: ${d.desc}` }];
      case 'warning':
        return [{ kind: 'unknown', type: `warning:${d.code}`, raw: msg }];
      case 'end_of_stream':
        return [];
      default:
        return [{ kind: 'unknown', type: msg.message_type, raw: msg }];
    }
  }
}
