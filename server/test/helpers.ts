// Fakes shared by the tests: no network, no real WebSocket.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Provider, rawToString, type ProviderEvent } from '../src/providers/provider.ts';

// Looks enough like a ws.WebSocket for Translator and broadcast
export class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  terminated = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.terminated = true; this.readyState = WebSocket.CLOSED; }
  // Simulate the vendor closing the connection
  drop(code = 1006): void { this.readyState = WebSocket.CLOSED; this.emit('close', code, Buffer.alloc(0)); }
}

// A provider whose sockets are FakeSockets and whose parse() returns whatever the test injects
export class FakeProvider extends Provider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly requiredEnv = [];
  readonly capabilities = { subtitles: true };
  readonly inputSampleRate = 24000;
  readonly rotateMarginMs = 1000;
  sockets: FakeSocket[] = [];
  closedGracefully: FakeSocket[] = [];

  healthRequest() { return { url: '' }; } // never fetched: no test touches index.ts
  connect(): WebSocket {
    const ws = new FakeSocket();
    this.sockets.push(ws);
    return ws as unknown as WebSocket;
  }
  sendAudio(ws: WebSocket, pcm: Buffer): void { ws.send(`audio:${pcm.length}`); }
  override close(ws: WebSocket): void { this.closedGracefully.push(ws as unknown as FakeSocket); ws.close(); }
  // Tests emit pre-parsed events: parse() just unwraps them
  parse(data: WebSocket.RawData): ProviderEvent[] { return JSON.parse(rawToString(data)) as ProviderEvent[]; }
}

// Deliver normalized events to a Translator through the socket, as the vendor would
export function emit(ws: FakeSocket, ...events: ProviderEvent[]): void {
  ws.emit('message', Buffer.from(JSON.stringify(events)));
}

export const raw = (obj: unknown): Buffer => Buffer.from(JSON.stringify(obj));
