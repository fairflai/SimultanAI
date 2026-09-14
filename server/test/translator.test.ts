import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Translator } from '../src/translator.ts';
import * as broadcast from '../src/broadcast.ts';
import { FakeProvider, FakeSocket, emit } from './helpers.ts';

await broadcast.init(['en']);

const setup = (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  delete process.env.ROTATE_MARGIN_MS;
  const provider = new FakeProvider();
  t.mock.method(console, 'log', () => {}); // keep the test output clean
  const translator = new Translator(provider, 'en');
  t.after(() => translator.close());
  return { provider, translator, first: provider.sockets[0] };
};

test('audio pushed before the session is ready is queued and flushed on ready', (t) => {
  const { translator, first } = setup(t);
  translator.push(Buffer.alloc(10));
  translator.push(Buffer.alloc(20));
  assert.deepEqual(first.sent, []);
  emit(first, { kind: 'ready' });
  assert.deepEqual(first.sent, ['audio:10', 'audio:20']);
  translator.push(Buffer.alloc(5));
  assert.deepEqual(first.sent.at(-1), 'audio:5');
});

test('the queue keeps at most 10 s of audio', (t) => {
  const { translator } = setup(t);
  const tenSeconds = 24000 * 2 * 10;
  translator.push(Buffer.alloc(tenSeconds));
  translator.push(Buffer.alloc(100));
  assert.equal(translator.queueBytes, 100); // the oldest chunk was dropped whole
});

test('translated audio and subtitles reach the language room', (t) => {
  const { first } = setup(t);
  const listener = new FakeSocket();
  broadcast.join('en', listener as never);
  emit(first, { kind: 'ready' }, { kind: 'audio', pcm: Buffer.alloc(960) }, { kind: 'subtitle', text: 'hi' }); // 960 bytes = one Opus packet
  assert.equal(listener.sent.length, 2);
  assert.equal(listener.sent[1], '{"type":"subtitle","delta":"hi"}');
  listener.emit('close');
});

test('an error while pending closes that session and never activates it', (t) => {
  const { provider, translator, first } = setup(t);
  emit(first, { kind: 'error', message: 'bad key' });
  assert.deepEqual(provider.closedGracefully, [first]);
  assert.equal(translator.active, null);
});

test('a dropped session is reopened with exponential backoff', (t) => {
  const { provider, first } = setup(t);
  emit(first, { kind: 'ready' });
  first.drop();
  assert.equal(provider.sockets.length, 1);
  t.mock.timers.tick(1600); // 1 s + up to 500 ms jitter
  assert.equal(provider.sockets.length, 2);
  provider.sockets[1].drop();
  t.mock.timers.tick(1600);
  assert.equal(provider.sockets.length, 2); // second attempt waits ~2 s
  t.mock.timers.tick(1000);
  assert.equal(provider.sockets.length, 3);
});

test('rotation: replacement opens rotateMarginMs before expiry, old session is drained then closed', (t) => {
  const { provider, translator, first } = setup(t);
  emit(first, { kind: 'expires', at: Date.now() + 5000 }, { kind: 'ready' });
  t.mock.timers.tick(3999);
  assert.equal(provider.sockets.length, 1);
  t.mock.timers.tick(1); // 5000 - rotateMarginMs (1000)
  assert.equal(provider.sockets.length, 2);
  const second = provider.sockets[1];
  translator.push(Buffer.alloc(8));
  assert.equal(first.sent.at(-1), 'audio:8'); // still on the old session until the new one is ready
  emit(second, { kind: 'ready' });
  translator.push(Buffer.alloc(9));
  assert.equal(second.sent.at(-1), 'audio:9');
  t.mock.timers.tick(40);
  assert.equal(first.sent.at(-1), 'audio:1920'); // 40 ms of silence at 24 kHz keeps the old session emitting
  assert.equal(first.closed, false);
  t.mock.timers.tick(10_000);
  assert.ok(first.closed);
  assert.equal(translator.active, second as never);
});

test('goaway on the active session rotates immediately', (t) => {
  const { provider, first } = setup(t);
  emit(first, { kind: 'ready' });
  emit(first, { kind: 'goaway', msLeft: 10_000 });
  assert.equal(provider.sockets.length, 2);
  emit(first, { kind: 'goaway', msLeft: 9_000 }); // a rotation is already pending
  assert.equal(provider.sockets.length, 2);
});

test('close() drains the active session and drops the rest', (t) => {
  const { provider, translator, first } = setup(t);
  emit(first, { kind: 'expires', at: Date.now() + 5000 }, { kind: 'ready' });
  t.mock.timers.tick(4000);
  const pending = provider.sockets[1];
  translator.close();
  assert.ok(pending.closed); // never became active: closed at once
  assert.equal(first.closed, false); // active: drained first
  t.mock.timers.tick(10_000);
  assert.ok(first.closed);
  translator.push(Buffer.alloc(1)); // ignored after close
  assert.equal(translator.queueBytes, 0);
});
