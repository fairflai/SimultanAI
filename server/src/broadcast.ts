// Per-language fan-out to WebSocket listeners. No buffering: late joiners hear the live stream.
import WebSocket from 'ws';

const rooms = new Map<string, Set<WebSocket>>(); // lang -> listeners

export function join(lang: string, ws: WebSocket): void {
  if (!rooms.has(lang)) rooms.set(lang, new Set());
  rooms.get(lang)!.add(ws);
  ws.on('close', () => rooms.get(lang)?.delete(ws));
}

function send(lang: string, payload: Buffer | string): void {
  const set = rooms.get(lang);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    else set.delete(ws);
  }
}

export function audio(lang: string, pcmBuffer: Buffer): void {
  send(lang, pcmBuffer); // binary frame: raw PCM16 mono 24 kHz
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
