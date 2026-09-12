import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as broadcast from '../src/broadcast.ts';
import { FakeSocket } from './helpers.ts';

test('broadcast: audio and text reach only the room of that language', () => {
  const it = new FakeSocket(), fr = new FakeSocket();
  broadcast.join('it', it as never);
  broadcast.join('fr', fr as never);
  broadcast.audio('it', Buffer.from('pcm'));
  broadcast.text('fr', { type: 'subtitle', delta: 'x' });
  assert.deepEqual(it.sent, [Buffer.from('pcm')]);
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
});
