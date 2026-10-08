import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/providers/impl/openai.ts';
import { GoogleProvider } from '../src/providers/impl/google.ts';
import { PalabraProvider } from '../src/providers/impl/palabra.ts';
import { createProvider } from '../src/providers/index.ts';
import { FakeSocket, raw } from './helpers.ts';

process.env.OPENAI_API_KEY = 'k';
process.env.GEMINI_API_KEY = 'k';
process.env.PALABRA_API_KEY = 'k';
process.env.PALABRA_SOURCE_LANG = 'it';

// --- factory -----------------------------------------------------------------
test('factory: PROVIDER env selects the provider, default openai', () => {
  delete process.env.PROVIDER;
  assert.equal(createProvider().name, 'openai');
  assert.equal(createProvider('google').name, 'google');
  process.env.PROVIDER = 'google';
  assert.equal(createProvider().name, 'google');
  delete process.env.PROVIDER;
});

test('factory: unknown name fails listing the valid ones', () => {
  assert.throws(() => createProvider('foo'), /unknown PROVIDER "foo".*openai, google, palabra/);
});

test('factory: models come from env with documented defaults', () => {
  assert.equal(createProvider('openai').model, 'gpt-realtime-translate');
  assert.equal(createProvider('google').model, 'gemini-3.5-live-translate-preview');
  process.env.OPENAI_MODEL = 'x';
  assert.equal(createProvider('openai').model, 'x');
  delete process.env.OPENAI_MODEL;
});

// --- OpenAI ------------------------------------------------------------------
const openai = new OpenAIProvider();

test('openai: setup selects the output language', () => {
  assert.deepEqual(openai.setupMessage('it'), { type: 'session.update', session: { audio: { output: { language: 'it' } } } });
});

test('openai: session.created carries the expiry in unix seconds', () => {
  assert.deepEqual(openai.parse(raw({ type: 'session.created', session: { expires_at: 1700000000 } }), 'it'),
    [{ kind: 'expires', at: 1700000000000 }]);
  assert.deepEqual(openai.parse(raw({ type: 'session.created', session: {} }), 'it'), []);
});

test('openai: session.updated is ready only with the requested language', () => {
  const updated = (language: string) => raw({ type: 'session.updated', session: { audio: { output: { language } } } });
  assert.deepEqual(openai.parse(updated('it'), 'it'), [{ kind: 'ready' }]);
  assert.deepEqual(openai.parse(updated('fr'), 'it'), [{ kind: 'error', message: 'session configured with wrong language fr' }]);
});

test('openai: audio and transcript deltas', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const [audio] = openai.parse(raw({ type: 'session.output_audio.delta', delta: pcm.toString('base64') }), 'it');
  assert.equal(audio.kind, 'audio');
  assert.ok(audio.kind === 'audio' && audio.pcm.equals(pcm));
  assert.deepEqual(openai.parse(raw({ type: 'session.output_transcript.delta', delta: 'ciao' }), 'it'), [{ kind: 'subtitle', text: 'ciao' }]);
});

test('openai: errors, unknown events and garbage', () => {
  assert.deepEqual(openai.parse(raw({ type: 'error', error: { message: 'bad' } }), 'it'), [{ kind: 'error', message: '{"message":"bad"}' }]);
  const [unknown] = openai.parse(raw({ type: 'whatever', x: 1 }), 'it');
  assert.equal(unknown.kind, 'unknown');
  assert.ok(unknown.kind === 'unknown' && unknown.type === 'whatever');
  assert.deepEqual(openai.parse(Buffer.from('not json'), 'it'), []);
});

test('openai: health probe is a GET of the model entry, bearer in the header', () => {
  assert.deepEqual(openai.healthRequest(), {
    url: 'https://api.openai.com/v1/models/gpt-realtime-translate',
    headers: { Authorization: 'Bearer k' },
  });
});

test('openai: audio is appended as base64, close sends session.close', () => {
  const ws = new FakeSocket();
  openai.sendAudio(ws as never, Buffer.from([0, 0]));
  assert.deepEqual(JSON.parse(ws.sent[0] as string), { type: 'session.input_audio_buffer.append', audio: 'AAA=' });
  openai.close(ws as never);
  assert.deepEqual(JSON.parse(ws.sent[1] as string), { type: 'session.close' });
  assert.ok(ws.closed);
});

// --- Google ------------------------------------------------------------------
const google = new GoogleProvider();

test('google: outputAudioTranscription sits at setup level, translationConfig in generationConfig', () => {
  const msg = google.setupMessage('pl') as { setup: Record<string, unknown> & { generationConfig: Record<string, unknown> } };
  assert.equal(msg.setup.model, 'models/gemini-3.5-live-translate-preview');
  assert.deepEqual(msg.setup.outputAudioTranscription, {});
  assert.equal('outputAudioTranscription' in msg.setup.generationConfig, false); // nesting it closes with 1007
  assert.deepEqual(msg.setup.generationConfig.translationConfig, { targetLanguageCode: 'pl' });
  assert.deepEqual(msg.setup.generationConfig.responseModalities, ['AUDIO']);
});

test('google: setupComplete makes the session ready with a 10 min budget', () => {
  const before = Date.now();
  const events = google.parse(raw({ setupComplete: {} }));
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'expires');
  assert.ok(events[0].kind === 'expires' && events[0].at >= before + 10 * 60_000 && events[0].at <= Date.now() + 10 * 60_000);
  assert.deepEqual(events[1], { kind: 'ready' });
});

test('google: one serverContent can carry audio parts and a transcript together', () => {
  const pcm = Buffer.from([9, 9, 9, 9, 9, 9]);
  const events = google.parse(raw({ serverContent: {
    modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] },
    outputTranscription: { text: 'hola' },
  } }));
  assert.equal(events.length, 2);
  assert.ok(events[0].kind === 'audio' && events[0].pcm.equals(pcm));
  assert.deepEqual(events[1], { kind: 'subtitle', text: 'hola' });
});

test('google: frames without audio or text are unknown, typed by their keys', () => {
  const [a] = google.parse(raw({ serverContent: { turnComplete: true } }));
  assert.ok(a.kind === 'unknown' && a.type === 'serverContent:turnComplete+serverContent');
  const [b] = google.parse(raw({ usageMetadata: { promptTokenCount: 1 } }));
  assert.ok(b.kind === 'unknown' && b.type === 'usageMetadata');
  assert.deepEqual(google.parse(Buffer.from('garbage')), []);
});

test('google: goAway timeLeft is a Duration string', () => {
  assert.deepEqual(google.parse(raw({ goAway: { timeLeft: '10s' } })), [{ kind: 'goaway', msLeft: 10000 }]);
  assert.deepEqual(google.parse(raw({ goAway: {} })), [{ kind: 'goaway', msLeft: 0 }]);
});

test('google: health probe is a GET of the model entry, key in the URL, no headers', () => {
  assert.deepEqual(google.healthRequest(), {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-live-translate-preview?key=k',
  });
});

test('google: audio frames declare the 16 kHz input rate', () => {
  const ws = new FakeSocket();
  google.sendAudio(ws as never, Buffer.from([0, 0]));
  assert.deepEqual(JSON.parse(ws.sent[0] as string), { realtimeInput: { audio: { data: 'AAA=', mimeType: 'audio/pcm;rate=16000' } } });
  assert.equal(google.inputSampleRate, 16000);
});

test('google: JSON may arrive as Buffer, ArrayBuffer or fragmented Buffer[]', () => {
  const buf = Buffer.from(JSON.stringify({ setupComplete: {} }));
  assert.equal(google.parse(buf)[1]?.kind, 'ready');
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  assert.equal(google.parse(arrayBuffer)[1]?.kind, 'ready');
  assert.equal(google.parse([buf.subarray(0, 5), buf.subarray(5)])[1]?.kind, 'ready');
});

// --- Palabra -----------------------------------------------------------------
const palabra = new PalabraProvider();
const pmsg = (message_type: string, data: unknown) => raw({ message_type, data });

test('palabra: set_task declares source, one target and the 24 kHz input', () => {
  const msg = palabra.setupMessage('en') as { message_type: string; data: { input_stream: { source: unknown }; pipeline: Record<string, unknown> } };
  assert.equal(msg.message_type, 'set_task');
  assert.deepEqual(msg.data.input_stream.source, { type: 'ws', format: 'pcm_s16le', sample_rate: 24000, channels: 1 });
  assert.equal((msg.data.pipeline.transcription as { source_language: string }).source_language, 'it');
  assert.deepEqual(msg.data.pipeline.translations, [{ target_language: 'en', translate_partial_transcriptions: true, speech_generation: {} }]);
  assert.equal(palabra.inputSampleRate, 24000);
});

test('palabra: ready only on the set_task acknowledgement, other statuses are unknown', () => {
  assert.deepEqual(palabra.parse(pmsg('task_status', { command: 'set_task', event: 'started', task_status: 'running' })), [{ kind: 'ready' }]);
  const [paused] = palabra.parse(pmsg('task_status', { command: 'pause_task', event: 'paused', task_status: 'paused' }));
  assert.ok(paused.kind === 'unknown' && paused.type === 'task_status:pause_task:paused');
});

test('palabra: data may arrive double-encoded as a JSON string', () => {
  assert.deepEqual(palabra.parse(pmsg('task_status', JSON.stringify({ command: 'set_task', event: 'started', task_status: 'running' }))), [{ kind: 'ready' }]);
});

test('palabra: audio chunks and final translations, segments separated by a space', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const [audio] = palabra.parse(pmsg('output_audio_data', { language: 'en', last_chunk: false, data: pcm.toString('base64') }));
  assert.ok(audio.kind === 'audio' && audio.pcm.equals(pcm));
  assert.deepEqual(palabra.parse(pmsg('translated_transcription', { transcription: { language: 'en', text: 'Nice weather.' } })),
    [{ kind: 'subtitle', text: 'Nice weather. ' }]);
  assert.deepEqual(palabra.parse(pmsg('translated_transcription', { transcription: { text: '' } })), []);
});

test('palabra: errors, warnings typed by code, end_of_stream and garbage', () => {
  assert.deepEqual(palabra.parse(pmsg('error', { code: 'VALIDATION_ERROR', desc: 'bad' })), [{ kind: 'error', message: 'VALIDATION_ERROR: bad' }]);
  const [warning] = palabra.parse(pmsg('warning', { code: 'AUDIO_STREAM_TOO_FAST', message: 'x' }));
  assert.ok(warning.kind === 'unknown' && warning.type === 'warning:AUDIO_STREAM_TOO_FAST');
  assert.deepEqual(palabra.parse(pmsg('end_of_stream', {})), []);
  assert.deepEqual(palabra.parse(Buffer.from('not json')), []);
});

test('palabra: health probe lists the sessions, bearer in the header', () => {
  assert.deepEqual(palabra.healthRequest(), {
    url: 'https://api.palabra.ai/session-storage/sessions?page_size=1',
    headers: { Authorization: 'Bearer k' },
  });
});

test('palabra: audio goes as input_audio_data, close sends end_task', () => {
  const ws = new FakeSocket();
  palabra.sendAudio(ws as never, Buffer.from([0, 0]));
  assert.deepEqual(JSON.parse(ws.sent[0] as string), { message_type: 'input_audio_data', data: { data: 'AAA=' } });
  palabra.close(ws as never);
  assert.deepEqual(JSON.parse(ws.sent[1] as string), { message_type: 'end_task', data: { force: false } });
  assert.ok(ws.closed);
});
