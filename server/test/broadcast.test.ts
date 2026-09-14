import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as broadcast from '../src/broadcast.ts';
import { PACKET_SAMPLES } from '../src/opus.ts';
import { FakeSocket } from './helpers.ts';

const PACKET_BYTES = PACKET_SAMPLES * 2; // exactly one Opus packet, no remainder
await broadcast.init(['it', 'fr', 'de', 'es']);

test('broadcast: audio and text reach only the room of that language', () => {
  const it = new FakeSocket(), fr = new FakeSocket();
  broadcast.join('it', it as never);
  broadcast.join('fr', fr as never);
  broadcast.audio('it', Buffer.alloc(PACKET_BYTES));
  broadcast.text('fr', { type: 'subtitle', delta: 'x' });
  assert.equal(it.sent.length, 1);
  assert.ok(it.sent[0] instanceof Uint8Array && it.sent[0].length < PACKET_BYTES); // Opus, not the PCM
  assert.deepEqual(fr.sent, ['{"type":"subtitle","delta":"x"}']);
  assert.deepEqual(broadcast.counts(), { it: 1, fr: 1 });
  it.emit('close'); fr.emit('close');
  assert.deepEqual(broadcast.counts(), { it: 0, fr: 0 });
});

test('broadcast: textAll hits every room, dead sockets are pruned on send', () => {
  const a = new FakeSocket(), dead = new FakeSocket();
  broadcast.join('de', a as never);
  broadcast.join('de', dead as never);
  dead.readyState = WebSocket.CLOSED;
  broadcast.textAll({ type: 'status', ingest: true });
  assert.equal(a.sent.length, 1);
  assert.equal(dead.sent.length, 0);
  assert.equal(broadcast.counts().de, 1);
  a.emit('close');
});

test('broadcast: a listener that does not drain its socket is closed with 4002', () => {
  const ok = new FakeSocket(), slow = new FakeSocket();
  broadcast.join('es', ok as never);
  broadcast.join('es', slow as never);
  slow.bufferedAmount = broadcast.MAX_BUFFERED_BYTES + 1;
  broadcast.text('es', { type: 'status', ingest: true });
  assert.equal(ok.sent.length, 1);
  assert.equal(slow.sent.length, 0);
  assert.equal(slow.closeCode, 4002);
  assert.equal(broadcast.counts().es, 1);
  ok.emit('close');
});
