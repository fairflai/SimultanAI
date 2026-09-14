// One provider session per target language. The vendor protocol lives in providers/impl/*.ts;
// this class only runs the generic lifecycle.
//
// Sessions expire (the provider reports when through the 'expires' event). To survive long events
// the Translator rotates sessions: a replacement is opened rotateMarginMs before expiry, input
// switches to it as soon as it is ready, and the old session is kept alive for HANDOVER_GRACE_MS
// (fed with silence) so it can finish emitting its translation.
import WebSocket from 'ws';
import * as broadcast from './broadcast.ts';
import type { Provider, ProviderEvent } from './providers/provider.ts';

const QUEUE_SECONDS = 10; // audio buffered while no session is active
const HANDOVER_GRACE_MS = 10_000; // keep a session open to drain its output after a rotation or on close
const SILENCE_CHUNK_MS = 40; // silence fed to a draining session, every SILENCE_CHUNK_MS
const RECONNECT_MAX_MS = 30_000;

export class Translator {
  readonly provider: Provider;
  readonly lang: string;
  readonly rotateMarginMs: number;
  readonly maxQueueBytes: number;
  readonly silenceChunk: Buffer;
  queue: Buffer[] = [];
  queueBytes = 0;
  closed = false;
  active: WebSocket | null = null; // ready session receiving the input audio
  pending: WebSocket | null = null; // session being opened (initial, reconnect or rotation)
  readonly sessions = new Set<WebSocket>(); // every open socket, for cleanup
  readonly openedAt = new WeakMap<WebSocket, number>(); // for the goaway log
  readonly timers = new Set<NodeJS.Timeout>();
  attempt = 0; // consecutive failed opens, drives the backoff
  readonly seenTypes = new Set<string>();

  constructor(provider: Provider, lang: string) {
    this.provider = provider;
    this.lang = lang;
    // ROTATE_MARGIN_MS overrides the provider default, mainly to test the rotation quickly
    this.rotateMarginMs = Number(process.env.ROTATE_MARGIN_MS) || provider.rotateMarginMs;
    const bytesPerSecond = provider.inputSampleRate * 2; // PCM16 mono
    this.maxQueueBytes = bytesPerSecond * QUEUE_SECONDS;
    this.silenceChunk = Buffer.alloc(bytesPerSecond * SILENCE_CHUNK_MS / 1000);
    this.openSession();
  }

  // --- session lifecycle -----------------------------------------------------

  openSession(): void {
    const ws = this.provider.connect(this.lang);
    this.pending = ws;
    this.sessions.add(ws);
    this.openedAt.set(ws, Date.now());

    ws.on('message', (data) => {
      for (const ev of this.provider.parse(data, this.lang)) this.handle(ws, ev);
    });

    ws.on('error', (err) => this.log(`ws error: ${err.message}`));

    ws.on('close', (code, reason) => {
      this.sessions.delete(ws);
      this.log(`session closed (${code} ${reason.toString()})`);
      if (this.closed) return;
      if (ws === this.active) this.active = null;
      if (ws === this.pending) this.pending = null;
      // The session that was carrying the audio (or the one meant to replace it) is gone: reopen with backoff.
      if (!this.active && !this.pending) this.reconnect();
    });
  }

  handle(ws: WebSocket, ev: ProviderEvent): void {
    switch (ev.kind) {
      case 'ready':
        if (ws === this.pending) this.activate(ws);
        break;
      case 'expires':
        this.scheduleRotation(ws, ev.at);
        break;
      case 'audio':
        broadcast.audio(this.lang, ev.pcm);
        break;
      case 'subtitle':
        broadcast.text(this.lang, { type: 'subtitle', delta: ev.text });
        break;
      case 'error':
        if (ws === this.pending) {
          // A pending session that errors (bad language, bad key) must never become active
          this.log(`API error while opening: ${ev.message}`);
          this.endSession(ws);
        } else {
          this.log(`API error: ${ev.message}`);
        }
        break;
      case 'goaway': {
        const age = Math.round((Date.now() - (this.openedAt.get(ws) ?? Date.now())) / 1000);
        this.log(`provider closes in ${Math.round(ev.msLeft / 1000)} s, session age ${age} s`);
        if (ws === this.active && !this.pending && !this.closed) {
          this.log('rotating session');
          this.openSession();
        }
        break;
      }
      case 'unknown':
        // Log each unknown event type once: this is how new vendor events get discovered
        if (!this.seenTypes.has(ev.type)) {
          this.seenTypes.add(ev.type);
          this.log(`event ${ev.type}: ${JSON.stringify(ev.raw).slice(0, 300)}`);
        }
        break;
      default: {
        const unreachable: never = ev; // a new ProviderEvent kind must be handled here
        this.log(`unhandled event ${JSON.stringify(unreachable)}`);
      }
    }
  }

  activate(ws: WebSocket): void {
    const old = this.active;
    this.active = ws;
    this.pending = null;
    this.attempt = 0;
    this.log(old ? 'session rotated' : 'session open');
    for (const chunk of this.queue) this.append(ws, chunk);
    this.queue = [];
    this.queueBytes = 0;
    if (old) this.drain(old);
  }

  // Keep the old session emitting for a while: it still holds audio we sent before the switch.
  drain(ws: WebSocket): void {
    const feed = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) this.append(ws, this.silenceChunk);
    }, SILENCE_CHUNK_MS);
    this.timers.add(feed);
    const stop = setTimeout(() => {
      clearInterval(feed);
      this.timers.delete(feed);
      this.timers.delete(stop);
      this.endSession(ws);
    }, HANDOVER_GRACE_MS);
    this.timers.add(stop);
  }

  // expiresAt: ms epoch
  scheduleRotation(ws: WebSocket, expiresAt: number): void {
    if (!expiresAt) return;
    const delay = Math.max(expiresAt - Date.now() - this.rotateMarginMs, 1000);
    this.log(`session expires in ${Math.round((expiresAt - Date.now()) / 60000)} min, rotation in ${Math.round(delay / 1000)} s`);
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.closed || ws !== this.active || this.pending) return; // superseded meanwhile
      this.log('rotating session');
      this.openSession();
    }, delay);
    this.timers.add(t);
  }

  reconnect(): void {
    const delay = Math.min(1000 * 2 ** this.attempt, RECONNECT_MAX_MS) + Math.random() * 500;
    this.attempt++;
    this.log(`reconnecting in ${Math.round(delay / 1000)} s (attempt ${this.attempt})`);
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) this.openSession();
    }, delay);
    this.timers.add(t);
  }

  endSession(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) this.provider.close(ws);
    else ws.terminate();
  }

  // --- audio in --------------------------------------------------------------

  // Raw PCM16 mono chunk at provider.inputSampleRate
  push(chunk: Buffer): void {
    if (this.closed) return;
    if (this.active?.readyState === WebSocket.OPEN) {
      this.append(this.active, chunk);
      return;
    }
    this.queue.push(chunk);
    this.queueBytes += chunk.length;
    while (this.queueBytes > this.maxQueueBytes) {
      this.queueBytes -= this.queue.shift()!.length;
    }
  }

  append(ws: WebSocket, chunk: Buffer): void {
    this.provider.sendAudio(ws, chunk);
  }

  // Stops accepting input. The active session is drained for HANDOVER_GRACE_MS so the last
  // sentence is translated in full instead of being cut when ffmpeg stops.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
    const active = this.active;
    this.active = null;
    for (const ws of this.sessions) if (ws !== active) this.endSession(ws);
    if (active) this.drain(active);
  }

  log(msg: string): void {
    console.log(`[${this.lang}] ${msg}`);
  }
}
