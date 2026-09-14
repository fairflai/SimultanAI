import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder } from 'libopus-wasm';
import { createOpusStream, PACKET_SAMPLES, SAMPLE_RATE } from '../src/opus.ts';

const PACKET_BYTES = PACKET_SAMPLES * 2;
const decoder = await createDecoder({ sampleRate: SAMPLE_RATE, channels: 1 });

// 20 ms of a 440 Hz tone
function tone(): Buffer {
  const pcm = Buffer.alloc(PACKET_BYTES);
  for (let i = 0; i < PACKET_SAMPLES; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 10000), i * 2);
  return pcm;
}

test('opus: PCM is re-framed into 20 ms packets, each decoding back to 20 ms', async () => {
  const packets: Uint8Array[] = [];
  const stream = await createOpusStream((p) => packets.push(p));
  stream.push(Buffer.concat([tone(), tone(), Buffer.alloc(100)])); // two packets and a remainder
  assert.equal(packets.length, 2);
  for (const p of packets) assert.equal(decoder.decode(p).length, PACKET_SAMPLES);
  assert.ok(packets[0].length < PACKET_BYTES / 4); // 32 kbit/s: a tone packet is a few dozen bytes
  stream.push(Buffer.alloc(PACKET_BYTES - 100)); // completes the pending packet exactly
  assert.equal(packets.length, 3);
});

test('opus: a partial packet waits for the next chunk, no silence is ever inserted', async () => {
  const packets: Uint8Array[] = [];
  const stream = await createOpusStream((p) => packets.push(p));
  stream.push(Buffer.alloc(100));
  assert.equal(packets.length, 0);
  stream.push(tone()); // 100 + 960 bytes: one packet, 100 bytes still pending
  assert.equal(packets.length, 1);
  stream.push(Buffer.alloc(PACKET_BYTES - 100)); // completes the pending packet exactly
  assert.equal(packets.length, 2);
  for (const p of packets) assert.equal(decoder.decode(p).length, PACKET_SAMPLES);
});
