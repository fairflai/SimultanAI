// Per-language fan-out to WebSocket listeners. No buffering: late joiners hear the live stream.
import WebSocket from 'ws';
import { createOpusStream, type OpusStream } from './opus.ts';

// A listener with this many bytes queued in its socket (about 30 s of Opus) is not keeping up: it is
// closed, otherwise everything it cannot drain piles up in the server's RAM
export const MAX_BUFFERED_BYTES = 128 * 1024;

const rooms = new Map<string, Set<WebSocket>>(); // lang -> listeners
const encoders = new Map<string, OpusStream>(); // lang -> outbound encoder shared by its listeners

// One encoder per language, created before the server listens (the codec loads asynchronously).
// audio() for a language not passed here is dropped silently.
export async function init(langs: string[]): Promise<void> {
  for (const lang of langs) encoders.set(lang, await createOpusStream((packet) => send(lang, packet)));
}

export function join(lang: string, ws: WebSocket): void {
  if (!rooms.has(lang)) rooms.set(lang, new Set());
  rooms.get(lang)!.add(ws);
  ws.on('close', () => rooms.get(lang)?.delete(ws));
}

function send(lang: string, payload: Uint8Array | string): void {
  const set = rooms.get(lang);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState !== WebSocket.OPEN) { set.delete(ws); continue; }
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { set.delete(ws); ws.close(4002, 'too slow'); continue; }
    ws.send(payload);
  }
}

// Translated PCM16 mono 24 kHz from the provider. Encoded once per language: each Opus packet is one
// binary frame to every listener. Nothing is encoded while nobody listens.
export function audio(lang: string, pcm: Buffer): void {
  if (!rooms.get(lang)?.size) return;
  encoders.get(lang)?.push(pcm);
}

export function text(lang: string, obj: object): void {
  send(lang, JSON.stringify(obj)); // text frame: JSON
}

export function textAll(obj: object): void {
  for (const lang of rooms.keys()) text(lang, obj);
}

export function counts(): Record<string, number> {
  return Object.fromEntries([...rooms].map(([lang, set]) => [lang, set.size]));
}
